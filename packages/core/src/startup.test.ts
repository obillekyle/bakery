import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from './core/config'
import { __resetPluginSetup, setupPlugins } from './startup'

/**
 * Guards against `PluginHooks.setup()` running twice per worker process.
 *
 * Two call sites both ran it: the CLI entry (`cli/dev.ts` / `cli/prod.ts`) and
 * `setupServer()`. Handler and mount registration is idempotent, which is why
 * nobody noticed — but the analytics plugin registers a shutdown hook and calls
 * `loadAnalyticsData()` from `setup()`, so it got two of each. Both call sites
 * are legitimate: the entries must run before `initImportMap()`, and
 * `setupServer()` must run because a cluster worker starts at `cli/worker.ts`
 * and passes through neither entry.
 */

let calls: string[] = []

function probePlugin(name = 'setup-probe') {
  return {
    name,
    setup: () => {
      calls.push(name)
    },
  }
}

beforeEach(async () => {
  await initConfig()
  calls = []
  __resetPluginSetup()
})

afterEach(() => {
  __resetTestConfig()
  __resetPluginSetup()
})

describe('setupPlugins', () => {
  test('runs plugin setup exactly once for both call sites', async () => {
    __setTestConfig({ plugins: [probePlugin()] })

    // The CLI entry, then setupServer().
    await setupPlugins()
    await setupPlugins()

    expect(calls).toEqual(['setup-probe'])
  })

  test('concurrent callers share one run rather than racing it', async () => {
    __setTestConfig({ plugins: [probePlugin()] })

    await Promise.all([setupPlugins(), setupPlugins(), setupPlugins()])

    expect(calls).toEqual(['setup-probe'])
  })

  test('sets every plugin up, in declaration order', async () => {
    __setTestConfig({
      plugins: [probePlugin('first'), probePlugin('second')],
    })

    await setupPlugins()

    expect(calls).toEqual(['first', 'second'])
  })

  test('the memo is process-wide and clearable for tests', async () => {
    __setTestConfig({ plugins: [probePlugin()] })

    await setupPlugins()
    __resetPluginSetup()
    await setupPlugins()

    expect(calls).toEqual(['setup-probe', 'setup-probe'])
  })
})
