import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Imported for its side effect, before the flags are captured below: init
// installs the mode accessors on `process.env`, and capturing before it runs
// means capturing `undefined` and restoring that into a flag other files read.
import './init'
import { setLogCallback } from '../logger/logger'
import { runStartupBanner } from '../startup'
import { DEFAULT_PORT } from '../utils/constants'
import { setModeFlag } from '../tests/fixtures'
import { clearHostConfigCache, getConfigLoadError, initConfig } from './config'

/**
 * A `server.config.ts` that is *present but broken* must never boot silently.
 *
 * The old behaviour logged one `CONFIG_IMPORT_ERR` line and continued on
 * `defaultConfig` — port 3000, root 'src', no plugins, no hosts — so the
 * developer chased "my dashboard disappeared" instead of "my config didn't
 * parse". In PROD that boot must not happen at all; in DEV it must be loud and
 * repeated in the startup banner. A *missing* config file stays perfectly fine:
 * zero-config boot is a supported feature.
 *
 * Real fixture directories rather than `__setTestConfig`, because the failure
 * under test happens *before* any config object exists to override.
 */

const ORIGINAL_CWD = process.cwd()

// Capture and restore a mode flag without changing its *type*.
//
// Two distinct leaks lived in this function, both of which broke a different
// file (`bundleModule` passes `PROD` to `Bun.build` as `minify`, which rejects
// anything non-boolean) and both of which only showed under full-suite
// ordering:
//
//   1. It deleted the flag when the capture found none — removing the accessor
//      `core/init` had installed in the meantime. The `import './init'` above
//      fixes that at the source by making the capture real.
//   2. It restored by assigning, on the stated reasoning that init's
//      getter/setter close over one `value` and re-defining the descriptor
//      would put the pair back but not the value. The reasoning is right; the
//      conclusion was wrong, because Bun's `process.env` proxy **stringifies on
//      write and not on read**. So this read a boolean `true` and wrote back
//      the string `"true"` — restoring a flag that now failed a `typeof` check
//      it had passed before.
//
// `setModeFlag` calls init's own setter directly, which reaches the closure
// while bypassing the proxy — the value goes back exactly as it came out.
function flagRestorer(flag: string) {
  const original = Object.getOwnPropertyDescriptor(process.env, flag)?.get?.()
  return () => setModeFlag(flag, original)
}

const restoreProd = flagRestorer('PROD')
const restoreWorker = flagRestorer('WORKER')

let brokenDir: string
let emptyDir: string

beforeAll(() => {
  brokenDir = mkdtempSync(join(tmpdir(), 'bakery-broken-config-'))
  // Unclosed brace: the dynamic import itself throws, which is the same shape
  // as any syntax error or unresolvable import in a real config.
  writeFileSync(
    join(brokenDir, 'server.config.ts'),
    'export default { port: 4123,\n',
  )
  emptyDir = mkdtempSync(join(tmpdir(), 'bakery-no-config-'))

  // Skip checkCacheVersion's `.cache` bookkeeping inside the temp dirs.
  setModeFlag('WORKER', true)
})

afterAll(() => {
  process.chdir(ORIGINAL_CWD)
  restoreWorker()
  clearHostConfigCache()
  rmSync(brokenDir, { recursive: true, force: true })
  rmSync(emptyDir, { recursive: true, force: true })
})

afterEach(() => {
  process.chdir(ORIGINAL_CWD)
  restoreProd()
  clearHostConfigCache()
  setLogCallback(() => {})
})

describe('initConfig with a broken server.config.ts', () => {
  test('PROD: refuses to boot on defaults', async () => {
    process.chdir(brokenDir)
    setModeFlag('PROD', true)
    clearHostConfigCache()

    // The throw is the contract: every PROD entry (prod.ts, threads.ts,
    // worker.ts) wraps initConfig in a catch that logs and exits 1.
    await expect(initConfig()).rejects.toThrow('server.config.ts')
  })

  test('PROD: a missing config file still zero-config boots', async () => {
    process.chdir(emptyDir)
    setModeFlag('PROD', true)
    clearHostConfigCache()

    const config = await initConfig()
    expect(config.port).toBe(DEFAULT_PORT)
  })

  test('DEV: boots on defaults rather than crash-looping the watcher', async () => {
    process.chdir(brokenDir)
    // Explicit, not assumed-absent: once any earlier file loads core/init
    // (the CLI tests do), PROD defaults to true under `bun test`.
    setModeFlag('PROD', false)
    clearHostConfigCache()

    const config = await initConfig()
    // Defaults, not the broken file's port — nothing of the file was applied.
    expect(config.port).toBe(DEFAULT_PORT)
    // …and the failure is recorded for the startup banner to restate.
    expect(getConfigLoadError()).toBeTruthy()
  })

  test('PROD: a missing config file records no load error', async () => {
    process.chdir(emptyDir)
    setModeFlag('PROD', true)
    clearHostConfigCache()

    await initConfig()
    expect(getConfigLoadError()).toBeNull()
  })

  test('DEV: the startup banner repeats the warning', async () => {
    process.chdir(brokenDir)
    setModeFlag('PROD', false)
    clearHostConfigCache()
    await initConfig()

    const lines: string[] = []
    setLogCallback(entry => lines.push(entry.msg))
    await runStartupBanner()

    // The import error scrolls away; the banner is what the developer reads.
    expect(lines.some(m => m.includes('server.config.ts'))).toBe(true)
  })

  test('DEV: a healthy config leaves the banner clean', async () => {
    process.chdir(emptyDir)
    setModeFlag('PROD', false)
    clearHostConfigCache()
    await initConfig()

    const lines: string[] = []
    setLogCallback(entry => lines.push(entry.msg))
    await runStartupBanner()

    expect(lines.some(m => m.includes('server.config.ts'))).toBe(false)
  })
})
