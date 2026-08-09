import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiHandler } from '../handlers/routes/api'

/**
 * Fixtures shared by more than one test file in this package.
 *
 * Deliberately not named `*.test.ts`: nothing here runs on its own, and Bun
 * would collect it as an empty suite. Everything in it existed as two or three
 * verbatim copies before, and the copies had already drifted — see `asProd`.
 */

/**
 * Run `fn` with one `import.meta.env` flag forced to `value`.
 *
 * The mode flags are accessors that `core/init.ts` installs on `process.env`,
 * so they are swapped by descriptor and put back: not assigned to, which throws
 * once init has defined the getter, and not module-mocked, which never unwinds
 * (see the `ip.test.ts` note in CLAUDE.md).
 *
 * Async on purpose, and this is the half that is easy to get wrong. The
 * handlers under test read these flags *after* several awaits, so a synchronous
 * wrapper restores the descriptor before the code it wraps ever looks — and
 * then silently tests the ambient mode instead of the requested one. Awaiting
 * inside the swap is what makes the wrapper mean anything. Of the three copies
 * this replaces, only one was async.
 */
export async function withEnvFlag<T>(
  flag: string,
  value: unknown,
  fn: () => T | Promise<T>,
): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process.env, flag)
  Object.defineProperty(process.env, flag, {
    get: () => value,
    configurable: true,
  })

  try {
    return await fn()
  } finally {
    if (original) Object.defineProperty(process.env, flag, original)
    else delete (process.env as any)[flag]
  }
}

/**
 * Set a mode flag and keep its type, for the cases `withEnvFlag` cannot cover —
 * a flag that has to stay set across several tests and be put back on a hook.
 *
 * The indirection is not ceremony. Bun's `process.env` is a proxy that
 * **stringifies on write but not on read**, so the obvious round trip silently
 * changes the type:
 *
 * ```ts no-check — demonstrates the bug this helper exists to avoid
 * const saved = process.env.PROD   // boolean true — reads pass through
 * process.env.PROD = saved         // string "true" — writes do not
 * ```
 *
 * That is not cosmetic. `bundleModule` hands the flag straight to `Bun.build`
 * as `minify`, and Bun rejects a non-boolean with "Expected minify to be a
 * boolean or an object" — so a test file that saved and restored `PROD`
 * correctly by every appearance still broke two NMHandler tests in a *different
 * file*, and only under full-suite ordering.
 *
 * Calling the descriptor's own setter bypasses the proxy, so the value arrives
 * at `core/init`'s closure unchanged.
 */
export function setModeFlag(flag: string, value: unknown): void {
  const desc = Object.getOwnPropertyDescriptor(process.env, flag)
  if (desc?.set) return void desc.set(value)

  // No accessor yet: this process never loaded `core/init`. Install one of the
  // same shape rather than assigning, which would stringify for the same
  // reason.
  Object.defineProperty(process.env, flag, {
    get: () => value,
    enumerable: true,
    configurable: true,
  })
}

export const asDev = <T>(fn: () => T | Promise<T>) =>
  withEnvFlag('DEV', true, fn)

/**
 * Production, spelled out in full.
 *
 * There were two incompatible `asProd`s: one forced `DEV=false`, the other
 * `PROD=true, TEST=false`. Neither was wrong so much as partial, because the
 * code under test gates on both spellings — `ErrorHandler.publicBody` asks
 * `DEV`, while the route cache-buster (`bustInDev`) asks `PROD && !TEST`. That
 * `!TEST` is load-bearing: `init.ts` defaults `PROD` to true whenever `--dev`
 * is absent, and `bun test` genuinely sets `TEST`, so a bare `PROD` gate is
 * already satisfied mid-suite. Forcing all three is the only statement that
 * reads as "production" to every gate at once.
 */
export const asProd = <T>(fn: () => T | Promise<T>) =>
  withEnvFlag('DEV', false, () =>
    withEnvFlag('PROD', true, () => withEnvFlag('TEST', false, fn)),
  )

/**
 * Execute an API route module, edit the file, execute it again.
 *
 * The pair of call sites is the whole point: `src/tests/api-isolation.test.ts`
 * runs this under the ambient (dev) flags and expects `second` to be the *new*
 * value, while `handlers/routes/api.test.ts` runs it under `asProd` and expects
 * Bun's module registry to hand back the *first*. That comparison only means
 * something if both take exactly the same steps, so the steps live here and the
 * expected values stay at the call sites.
 *
 * The temp directory is returned rather than removed: the two suites unwind on
 * different hooks.
 */
export async function executeAcrossEdit(
  prefix: string,
  run: (fn: () => Promise<any>) => Promise<any> = fn => fn(),
): Promise<{ dir: string; first: any; second: any }> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const file = join(dir, 'handler.ts')
  const req = new Request('http://localhost/api/test')

  await writeFile(file, "export default () => 'first'")
  const first = await run(() =>
    ApiHandler.executeModule(file as any, req, null),
  )

  // A distinct mtime, which is what the dev cache-buster keys on. Without the
  // pause both writes can land in the same millisecond and the reload case
  // passes for the wrong reason.
  await new Promise(resolve => setTimeout(resolve, 10))
  await writeFile(file, "export default () => 'second'")
  const second = await run(() =>
    ApiHandler.executeModule(file as any, req, null),
  )

  return { dir, first, second }
}
