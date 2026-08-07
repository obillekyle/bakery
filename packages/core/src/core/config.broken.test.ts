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
import { setLogCallback } from '../logger/logger'
import { runStartupBanner } from '../startup'
import { DEFAULT_PORT } from '../utils/constants'
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

// A mode flag may be a plain (absent) env var or the accessor init.ts
// installs — which of the two depends on whether an earlier test file
// evaluated init. Deleting unconditionally removed the accessor and left
// later files seeing a different flag than they would in isolation:
// init.test.ts's accessor-pair check failed on exactly this, and only on
// Linux CI, whose test-file ordering evaluates init before this file runs.
// Restoring the captured value through whichever shape exists is
// order-independent.
function flagRestorer(flag: string) {
  const had = flag in process.env
  const original = (process.env as any)[flag]
  return () => {
    if (had) {
      ;(process.env as any)[flag] = original
      return
    }
    const desc = Object.getOwnPropertyDescriptor(process.env, flag)
    if (desc?.set) (process.env as any)[flag] = undefined
    else delete (process.env as any)[flag]
  }
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
  process.env.WORKER = '1'
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
    process.env.PROD = '1'
    clearHostConfigCache()

    // The throw is the contract: every PROD entry (prod.ts, threads.ts,
    // worker.ts) wraps initConfig in a catch that logs and exits 1.
    await expect(initConfig()).rejects.toThrow('server.config.ts')
  })

  test('PROD: a missing config file still zero-config boots', async () => {
    process.chdir(emptyDir)
    process.env.PROD = '1'
    clearHostConfigCache()

    const config = await initConfig()
    expect(config.port).toBe(DEFAULT_PORT)
  })

  test('DEV: boots on defaults rather than crash-looping the watcher', async () => {
    process.chdir(brokenDir)
    // Explicit, not assumed-absent: once any earlier file loads core/init
    // (the CLI tests do), PROD defaults to true under `bun test`.
    ;(process.env as any).PROD = ''
    clearHostConfigCache()

    const config = await initConfig()
    // Defaults, not the broken file's port — nothing of the file was applied.
    expect(config.port).toBe(DEFAULT_PORT)
    // …and the failure is recorded for the startup banner to restate.
    expect(getConfigLoadError()).toBeTruthy()
  })

  test('PROD: a missing config file records no load error', async () => {
    process.chdir(emptyDir)
    process.env.PROD = '1'
    clearHostConfigCache()

    await initConfig()
    expect(getConfigLoadError()).toBeNull()
  })

  test('DEV: the startup banner repeats the warning', async () => {
    process.chdir(brokenDir)
    ;(process.env as any).PROD = ''
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
    ;(process.env as any).PROD = ''
    clearHostConfigCache()
    await initConfig()

    const lines: string[] = []
    setLogCallback(entry => lines.push(entry.msg))
    await runStartupBanner()

    expect(lines.some(m => m.includes('server.config.ts'))).toBe(false)
  })
})
