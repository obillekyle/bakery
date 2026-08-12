import { afterEach, describe, expect, test } from 'bun:test'
import './init'

/**
 * `core/init.ts` defines the mode flags as accessors on `process.env`. They
 * were getter-only, which makes them readonly — and in strict-mode ESM an
 * assignment to a readonly property throws rather than being ignored.
 *
 * `threads.ts` assigns these flags before importing the worker: `THREAD_ID`
 * on the single-worker/clamped path (deliberately *not* `THREAD_WORKER`
 * there — a cluster of one must not shrink its caches), and both via Worker
 * env in the multi-worker path. Historically the assignment was wrapped in
 * `Try(...)` while the accessors were getter-only: the TypeError was
 * swallowed, the flag never moved, and `reusePort`, the per-worker
 * statement-cache scaling and the startup banner all quietly kept reading
 * the master's values. Nothing failed loudly; the code path was simply
 * dead, and the `Try(...)` made it look deliberate.
 *
 * ## Why the restore is this careful
 *
 * These flags are process-global and every later test file in the run reads
 * them, so a leak here is a failure somewhere else. Two ways to leak, both hit
 * on the way to this version:
 *
 * - Restoring by assignment does not work. `process.env` coerces the assigned
 *   value to a string, so `DEV`'s boolean `false` comes back as the *truthy*
 *   string `"false"` — which flipped dev-only behaviour for three tests in
 *   `handlers/` and `dashboard/` that this file merely happened to precede.
 * - Restoring the saved property *descriptor* does not work either: its getter
 *   closes over the very variable the setter just overwrote, so putting it back
 *   puts the new value back with it.
 *
 * So only the two flags `threads.ts` actually assigns are ever written, and
 * they are restored by rebuilding an accessor over the original value.
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
const saved = new Map<string, unknown>()

function restore(flag: string, original: unknown): void {
  let value = original
  Object.defineProperty(process.env, flag, {
    get: () => value,
    set: (next: unknown) => {
      value = next
    },
    enumerable: true,
    configurable: true,
  })
}

afterEach(() => {
  for (const [flag, original] of saved) restore(flag, original)
  saved.clear()
})

/** Assign through the real setter, remembering the value to put back. */
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

  test('every mode flag is an accessor pair, not a bare getter', () => {
    // The other six are inspected rather than written: a getter-only property
    // is readonly whichever flag it is, and writing them would leak.
    for (const flag of FLAGS) {
      const descriptor = Object.getOwnPropertyDescriptor(process.env, flag)
      expect(descriptor).toBeDefined()
      expect(typeof descriptor!.get).toBe('function')
      expect(typeof descriptor!.set).toBe('function')
    }
  })

  test('import.meta.env sees the assignment', () => {
    // Everything downstream branches on `import.meta.env.*`, which reads these
    // same properties; a setter that only updated a private copy would be no
    // better than the throw it replaced.
    for (const flag of WRITTEN) assign(flag, '1')

    expect(import.meta.env.THREAD_WORKER).toBe('1' as any)
    expect(Boolean(import.meta.env.THREAD_WORKER)).toBe(true)
  })

  test('leaves the flags as it found them', () => {
    // Self-check on the restore above, which is the part that has already gone
    // wrong twice. Runs last; a leak from the tests above shows up here rather
    // than in an unrelated file three packages away.
    expect(typeof env.DEV).toBe('boolean')
    expect(typeof env.THREAD_WORKER).toBe('boolean')
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
