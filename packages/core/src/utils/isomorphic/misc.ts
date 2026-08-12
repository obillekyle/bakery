import { is } from './is'

export function throws(message: string | Error): never {
  throw is.string(message) ? new Error(message) : message
}

export function assert(condition: any, message?: string): asserts condition {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

/** Escape hatch for casting through `any` without spelling it out each time. */
export function any<T = any>(value: any): T {
  return value
}

/**
 * A hex id of `length` characters, from `crypto.getRandomValues`.
 *
 * Isomorphic, and moving it here is what made it so: it lived in
 * `client/utils.ts` as a browser global only, so the same call in a server
 * block was a ReferenceError — reported from an app. `crypto` is a global in
 * both runtimes; nothing here is browser-specific.
 */
export function randomId(length = 8) {
  const arr = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(arr)
  return Array.from(arr, dec => dec.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

export function repeat(n: number): number[]
export function repeat<T>(n: number, fn: (i: number) => T): T[]
export function repeat<T>(n: number, fn?: (i: number) => T): unknown[] {
  return Array.from({ length: n }, (_, k) => (fn ? fn(k) : k))
}
