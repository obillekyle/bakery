import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Bakery } from '@bakery/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery/core/core/config'
import {
  __resetShutdownSequence,
  __resetTestTeardown,
  __setTestTeardown,
  runShutdownSequence,
  SHUTDOWN_TIMEOUT_MS,
} from './shutdown'
import { FLUSH_TIMEOUT_MS } from './threads'

/**
 * Guards the wiring of `AppConfig.onShutdown`, which was declared in
 * `global.d.ts`, defaulted to `NOOP` in `core/config.ts`, and called by nothing:
 * `worker.ts` ran `Bakery.shutdownHooks` and `PluginHooks.onShutdown()` only, so
 * an application's shutdown handler silently never fired.
 */

let calls: string[] = []
let savedHooks: (() => Promise<void> | void)[] = []

beforeEach(async () => {
  await initConfig()
  calls = []

  // `cache/tiered.ts` and `session.ts` push real hooks onto this array at
  // import time — one of them closes the cache database. Running those here
  // would break every test file loaded afterwards, so the array is emptied for
  // the duration and restored below.
  savedHooks = Bakery.shutdownHooks.splice(0, Bakery.shutdownHooks.length)
  __resetShutdownSequence()

  // The real teardown closes the shared cache database and the ORM connection
  // for the whole process — fine at exit, fatal to every test file scheduled
  // after this one. Record the calls instead.
  __setTestTeardown({
    closeCache: () => {
      calls.push('close-cache')
    },
    closeDatabase: () => {
      calls.push('close-db')
    },
  })
})

afterEach(() => {
  Bakery.shutdownHooks.length = 0
  Bakery.shutdownHooks.push(...savedHooks)
  __resetTestConfig()
  __resetTestTeardown()
  __resetShutdownSequence()
})

describe('runShutdownSequence', () => {
  test('calls the application onShutdown hook', async () => {
    __setTestConfig({
      onShutdown: () => {
        calls.push('app')
      },
    })

    await runShutdownSequence()

    expect(calls).toEqual(['app', 'close-cache', 'close-db'])
  })

  test('runs app hook, then framework hooks, then plugins, then resource close', async () => {
    // Reverse of startup: runStartupBanner() calls PluginHooks.onStart() and
    // then config.onStart() last, so config.onShutdown() comes first here. It
    // also has to precede the framework hooks, which flush the cache tier an
    // app hook may still want to write through.
    //
    // The tail is the regression. `cache/tiered.ts` closed the shared cache
    // database inside its own framework hook — registered at module-evaluation
    // time, so first of all of them, and therefore before every plugin. The
    // analytics shutdown flush writes through that same handle: its statements
    // threw, an outer catch swallowed them, and up to a minute of page hits
    // plus the entire history delta vanished on every clean stop. The ORM
    // connection was worse — `closeDB()`'s only caller was the `db:sync` CLI,
    // so a SIGINT abandoned a live MySQL/Postgres pool. Both now run here,
    // after the plugins, and both are visible in this order.
    __setTestConfig({
      onShutdown: () => {
        calls.push('app')
      },
      plugins: [
        {
          name: 'order-probe',
          onShutdown: () => {
            calls.push('plugin')
          },
        },
      ],
    })

    Bakery.shutdownHooks.push(() => {
      calls.push('framework')
    })

    await runShutdownSequence()

    expect(calls).toEqual([
      'app',
      'framework',
      'plugin',
      'close-cache',
      'close-db',
    ])
  })

  test('a throwing app hook does not abort the rest', async () => {
    // A shutdown that stops halfway loses exactly the data it exists to save.
    __setTestConfig({
      onShutdown: () => {
        calls.push('app')
        throw new Error('deliberate: app onShutdown blew up')
      },
      plugins: [
        {
          name: 'order-probe',
          onShutdown: () => {
            calls.push('plugin')
          },
        },
      ],
    })

    Bakery.shutdownHooks.push(() => {
      calls.push('framework')
    })

    await runShutdownSequence()

    expect(calls).toEqual([
      'app',
      'framework',
      'plugin',
      'close-cache',
      'close-db',
    ])
  })

  test('awaits an async application hook before moving on', async () => {
    __setTestConfig({
      onShutdown: async () => {
        await Bun.sleep(5)
        calls.push('app')
      },
    })

    Bakery.shutdownHooks.push(() => {
      calls.push('framework')
    })

    await runShutdownSequence()

    expect(calls).toEqual(['app', 'framework', 'close-cache', 'close-db'])
  })

  test('runs once when a signal and the cluster master both ask', async () => {
    __setTestConfig({
      onShutdown: () => {
        calls.push('app')
      },
    })

    await Promise.all([runShutdownSequence(), runShutdownSequence()])
    await runShutdownSequence()

    expect(calls).toEqual(['app', 'close-cache', 'close-db'])
  })

  test('a throwing teardown step does not stop the next one', async () => {
    __setTestConfig({})
    __setTestTeardown({
      closeCache: () => {
        calls.push('close-cache')
        throw new Error('deliberate: cache close blew up')
      },
      closeDatabase: () => {
        calls.push('close-db')
      },
    })

    await runShutdownSequence()

    expect(calls).toEqual(['close-cache', 'close-db'])
  })

  test('gives up on a hook that never settles rather than hanging', async () => {
    // The cluster master already bounded its wait, with a comment saying a
    // wedged worker must delay shutdown, not prevent it. The standalone path
    // did not honour its own principle: `worker.ts` awaited this sequence
    // before `process.exit(0)`, so one hook that never resolved meant SIGINT
    // never terminated the process at all — Ctrl-C looked like it did nothing.
    __setTestConfig({})
    Bakery.shutdownHooks.push(() => new Promise<void>(() => {}))
    Bakery.shutdownHooks.push(() => {
      calls.push('unreachable')
    })

    const started = Bun.nanoseconds()
    await runShutdownSequence(50)
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6

    // The point is that it returns at all; the figure just has to be far below
    // an unbounded wait.
    expect(elapsedMs).toBeLessThan(3000)
    expect(calls).toEqual([])
  })

  test('the standalone deadline is the one the cluster master uses', () => {
    // Two paths, one principle — and one constant, so they cannot drift.
    expect(SHUTDOWN_TIMEOUT_MS).toBe(FLUSH_TIMEOUT_MS)
  })
})
