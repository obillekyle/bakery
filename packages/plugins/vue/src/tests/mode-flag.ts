// For its side effect, first: init installs the flag this module restores, and
// a value captured before it would be restored to nothing.
import '@bakery-framework/core/core/init'

/**
 * Run `fn` with `PROD` set, and put the flag back afterwards: once `fn`
 * returns, or once the promise it returns settles.
 *
 * Core's test fixtures are not a published subpath, so this reproduces init's
 * encoding for the plugin's tests: the same allowance `orm/sync/engine.test.ts`
 * has, and for the same reason. One copy for the whole plugin, so there is one
 * place the encoding is spelled. The encoding is the load-bearing part: the
 * flags are `'1'`/`''` strings since Bun 1.4 stopped accepting accessor
 * descriptors on `process.env`, and a plain `false` stores the string
 * `"false"`, which is truthy.
 *
 * Restored, never deleted. init has installed `PROD` by the time this runs,
 * and deleting a flag you do not own leaves it `undefined` for every file that
 * runs after, which is the leak `conventions.test.ts` bans outright.
 */
export function withProdFlag<T>(value: boolean, fn: () => T): T {
  const original = process.env.PROD
  process.env.PROD = value ? '1' : ''
  let result: T
  try {
    result = fn()
  } catch (error) {
    process.env.PROD = original
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(() => {
      process.env.PROD = original
    }) as T
  }
  process.env.PROD = original
  return result
}
