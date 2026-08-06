import { Bakery } from '@bakery/core/core/bakery'
import { errorMsg, log, serveLog } from '@bakery/core/logger'
import { Try } from '@bakery/core/utils/common'
import { FLUSH_TIMEOUT_MS } from './threads'

let running: Promise<void> | null = null

/**
 * How long this process gives its own teardown before giving up on it.
 *
 * The same bound the cluster master applies to a worker's pre-terminate flush,
 * for the same reason it states: *a wedged worker must delay shutdown, not
 * prevent it*. The standalone path did not honour that — `runShutdownSequence()`
 * gated `process.exit(0)` with no deadline, so one hook that never settled meant
 * SIGINT never terminated the process and Ctrl-C appeared to do nothing.
 */
export const SHUTDOWN_TIMEOUT_MS = FLUSH_TIMEOUT_MS

/**
 * The two teardown steps that close process-wide resources. Behind a seam
 * because a test that ran the real ones would close the cache database and the
 * ORM connection for every test file scheduled after it — see `__setTestDb` in
 * `orm/connection.ts` for the same pattern and the same reason.
 */
export interface ShutdownTeardown {
  closeCache: () => Promise<void> | void
  closeDatabase: () => Promise<void> | void
}

const defaultTeardown: ShutdownTeardown = {
  closeCache: async () => {
    const { closeCacheDb } = await import('@bakery/core/cache/tiered')
    closeCacheDb()
  },
  closeDatabase: async () => {
    const { closeDB } = await import('@bakery/orm/connection')
    await closeDB()
  },
}

let testTeardown: ShutdownTeardown | null = null

/** Test seam — see `ShutdownTeardown`. */
export function __setTestTeardown(teardown: ShutdownTeardown): void {
  testTeardown = teardown
}

export function __resetTestTeardown(): void {
  testTeardown = null
}

/**
 * Run every teardown step this process owns, once.
 *
 * Memoised rather than guarded by a boolean: a cluster worker can be asked to
 * flush by the master *and* receive a signal, and the second caller has to wait
 * for the first run to finish rather than race it or skip it.
 *
 * ## Order
 *
 * 1. `Bakery.config.onShutdown()` — the application's own hook.
 * 2. `Bakery.shutdownHooks` — framework internals (tiered-cache flush, session
 *    prune timer).
 * 3. `PluginHooks.onShutdown()` — plugins.
 * 4. Resource close — the shared cache database, then the ORM connection.
 *
 * The app goes first because it is the only participant that can still need the
 * framework intact: step 2 flushes the session/cache tier, so an app hook that
 * wants to write a last session value has to run before it, not after. That is
 * also the exact reverse of startup, where `runStartupBanner()` calls
 * `PluginHooks.onStart()` and then `config.onStart()` last — last up, first down.
 *
 * Step 4 exists because steps 1–3 all still write. `cache/tiered.ts` used to
 * close the shared cache database inside its own step-2 hook, which is
 * registered at module-evaluation time and so runs *first* of all the framework
 * hooks — before every plugin. The analytics plugin's shutdown flush binds that
 * same handle, so its statements threw and its page-hit and history deltas were
 * dropped on every clean stop. The ORM connection was closed by nothing at all:
 * `closeDB()` had exactly one caller, the `db:sync` CLI, so a SIGINT abandoned
 * a MySQL or Postgres pool mid-flight.
 *
 * Every step is isolated: a throwing hook is reported and the rest still run.
 * A shutdown that aborts halfway loses precisely the data this sequence exists
 * to save. The whole sequence is bounded by `timeoutMs` for the same reason —
 * losing the tail of a flush beats never exiting.
 */
export function runShutdownSequence(
  timeoutMs: number = SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  running ??= withDeadline(shutdown(), timeoutMs)
  return running
}

/** Test seam — see `__setTestConfig`. Clears the once-per-process memo. */
export function __resetShutdownSequence(): void {
  running = null
}

async function step(what: string, fn: () => unknown): Promise<void> {
  const [err] = await Try.catch(fn)
  if (err) {
    serveLog.UNHANDLED_ERR({ error: `Error in ${what}: ${errorMsg(err)}` })
  }
}

async function withDeadline(
  work: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  // `shutdown()` isolates every step, so it settles rather than rejects; the
  // catch is belt-and-braces against a future step escaping `step()`.
  const outcome = await Promise.race([
    work.then(() => 'done' as const).catch(() => 'done' as const),
    deadline,
  ])
  clearTimeout(timer)

  if (outcome === 'timeout') {
    log({
      level: 'warn',
      msg: `[Shutdown] Teardown did not finish within ${timeoutMs}ms; exiting anyway.`,
    })
  }
}

async function shutdown(): Promise<void> {
  await step('config.onShutdown', () => Bakery.config.onShutdown())

  for (const hook of Bakery.shutdownHooks) {
    await step('shutdown hook', hook)
  }

  // Inside the step, not above it: an `await import()` that fails throws, and
  // out here that rejection escaped the sequence entirely — taking the resource
  // close below with it and, in `worker.ts`, the `process.exit(0)` that follows.
  await step('plugin onShutdown', async () => {
    const { PluginHooks } = await import('@bakery/core/core/plugins')
    await PluginHooks.onShutdown()
  })

  const teardown = testTeardown ?? defaultTeardown
  await step('cache database close', () => teardown.closeCache())
  await step('database close', () => teardown.closeDatabase())
}
