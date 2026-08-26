import { afterEach, describe, expect, test } from 'bun:test'
import './init'

/**
 * `core/init.ts` puts the mode flags on `process.env` as `'1'`/`''` strings.
 *
 * They were booleans behind accessor pairs until Bun 1.4.0, which rejects
 * accessor descriptors on `process.env` outright — the framework died on
 * `import` in every entry. The tests here used to assert that mechanism
 * directly (`typeof descriptor.get === 'function'`), which made them a
 * restatement of the implementation rather than of anything it guaranteed. They
 * now assert the guarantees, all of which survived the encoding change.
 *
 * `threads.ts` assigns these before importing the worker: `THREAD_ID` on the
 * single-worker/clamped path (deliberately *not* `THREAD_WORKER` there — a
 * cluster of one must not shrink its caches), and both via Worker env in the
 * multi-worker path. When the flags were getter-only accessors that assignment
 * threw, the throw was swallowed by a `Try(...)`, and `reusePort`, the
 * per-worker statement-cache scaling and the startup banner all quietly read
 * the master's values. Nothing failed loudly; the path was dead and the
 * `Try(...)` made it look deliberate.
 *
 * ## Why the restore is careful
 *
 * These flags are process-global and every later test file reads them, so a
 * leak here is a failure somewhere else — it has happened twice. Restoring is
 * now a plain assignment, which is correct *because* everything is already a
 * string: the old hazard was that assignment coerced boolean `false` to the
 * truthy string `"false"`, flipping dev-only behaviour in three tests in
 * `handlers/` and `dashboard/` that this file merely happened to precede. The
 * `''` encoding is what removes that trap rather than working around it.
 */
const FLAGS = [
  'DEV',
  'TEST',
  'PROD',
  'WORKER',
  'DEV_WORKER',
  'THREAD_WORKER',
  'THREAD_ID',
  'MODE',
] as const

/** The only two the cluster master writes — and so the only two written here. */
const WRITTEN = ['THREAD_WORKER', 'THREAD_ID'] as const

const env = process.env as any
const saved = new Map<string, string>()

afterEach(() => {
  for (const [flag, original] of saved) env[flag] = original
  saved.clear()
})

/** Assign, remembering the value to put back. */
function assign(flag: string, value: string): void {
  if (!saved.has(flag)) saved.set(flag, env[flag])
  env[flag] = value
}

describe('core/init mode flags', () => {
  test('THREAD_WORKER and THREAD_ID can be set, which is what threads.ts does', () => {
    expect(() => assign('THREAD_WORKER', '1')).not.toThrow()
    expect(env.THREAD_WORKER).toBe('1')

    expect(() => assign('THREAD_ID', '3')).not.toThrow()
    expect(env.THREAD_ID).toBe('3')
  })

  test('every mode flag is present and is a string', () => {
    // Presence is the load-bearing half. `utils/http/authorize.ts` distinguishes
    // "explicitly not production" (`''`) from "this process never booted through
    // init" (`undefined`) and fails closed on the latter, so a flag that is
    // absent rather than empty opens a door.
    for (const flag of FLAGS) {
      expect(`${flag} in env`).toBe(`${flag} ${flag in process.env ? 'in' : 'MISSING FROM'} env`)
      expect(typeof env[flag]).toBe('string')
    }
  })

  test('a false flag is falsy — never the string "false"', () => {
    // The whole reason for `'1'`/`''` rather than `'true'`/`'false'`. Every
    // gate in the codebase tests these for truthiness, and `"false"` is a
    // truthy string: this encoding failing would not throw anywhere, it would
    // silently invert every `if (import.meta.env.DEV)` in the framework.
    for (const flag of FLAGS) {
      expect(`${flag}=${env[flag]}`).not.toBe(`${flag}=false`)
      expect(`${flag}=${env[flag]}`).not.toBe(`${flag}=true`)
    }

    // Under `bun test` exactly one of DEV/PROD is on, and the other must read
    // falsy rather than merely "not '1'".
    expect(Boolean(env.DEV) === Boolean(env.PROD)).toBe(false)
  })

  test('import.meta.env sees the assignment', () => {
    // Everything downstream branches on `import.meta.env.*`, which is the same
    // object as `process.env` in Bun — verified, and the reason the flags could
    // not simply move somewhere else when accessors stopped working.
    for (const flag of WRITTEN) assign(flag, '1')

    expect(import.meta.env.THREAD_WORKER).toBe('1')
    expect(Boolean(import.meta.env.THREAD_WORKER)).toBe(true)
  })

  test('leaves the flags as it found them', () => {
    // Self-check on the restore above, which is the part that has already gone
    // wrong twice. Runs last; a leak from the tests above shows up here rather
    // than in an unrelated file three packages away.
    expect(typeof env.DEV).toBe('string')
    expect(typeof env.THREAD_WORKER).toBe('string')
    expect(env.MODE).toBe(process.env.MODE)
  })
})

describe('core/init globals', () => {
  test('randomId is bound on the server, same function as the isomorphic one', async () => {
    // The report behind this: it was a browser-only global, so the same call
    // in an SFC server block was a ReferenceError.
    const { randomId } = await import('../utils/isomorphic/misc')
    expect((globalThis as any).randomId).toBe(randomId)
    const id = (globalThis as any).randomId(12)
    expect(id).toMatch(/^[0-9a-f]{12}$/)
  })
})
