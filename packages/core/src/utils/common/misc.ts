/**
 * `is`, `Math2` and `throws` moved to `utils/isomorphic/` — the client bundle
 * carried its own copies of all three. They are re-exported here so existing
 * `@server/utils` importers are unaffected.
 *
 * `deferredValue` / `hasDeferredValue` stay: they are server-only in practice
 * and were never duplicated.
 */
import type { MapOf } from '../../types'

export { is } from '../isomorphic/is'
export { Math2 } from '../isomorphic/math'
export { throws } from '../isomorphic/misc'

const DEFERRED = Symbol('deferred')
export function deferredValue<O extends object, T>(
  object: O,
  key: string,
  value: (this: O, o: O) => T,
) {
  if (!(DEFERRED in object)) {
    Object.defineProperty(object, DEFERRED, {
      enumerable: false,
      configurable: false,
      writable: false,
      value: {},
    })
  }

  const map = (object as any)[DEFERRED] as MapOf<any>

  Object.defineProperty(object, key, {
    enumerable: true,
    configurable: true,
    get() {
      if (key in map) return map[key]
      map[key] = value.call(this, this)
      return map[key]
    },
    set(val) {
      map[key] = val
    },
  })
}

export function hasDeferredValue<
  O extends object,
  T extends keyof O | (string & {}),
>(object: object, key: T): boolean {
  if (!(DEFERRED in object)) return false
  const map = object[DEFERRED] as MapOf<any>
  return key in map
}
