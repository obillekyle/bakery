/**
 * `Case` moved to `utils/isomorphic/case` — the client bundle carried an
 * identical copy. `toHash` stays here: it calls `Bun.hash`, so it is server-only
 * and must not be pulled into the isomorphic layer.
 */
export * from '../isomorphic/case'

export function toHash(str = '') {
  str ||= Math.random().toString(16).slice(2)
  return Bun.hash(str).toString(36)
}
