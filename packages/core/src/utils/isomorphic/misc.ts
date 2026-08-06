import { is } from './is'

export function throws(message: string | Error): never {
  throw is.string(message) ? new Error(message) : message
}

export function assert(
  condition: any,
  message?: string,
): asserts condition {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

/** Escape hatch for casting through `any` without spelling it out each time. */
export function any<T = any>(value: any): T {
  return value
}

export function repeat(n: number): number[]
export function repeat<T>(n: number, fn: (i: number) => T): T[]
export function repeat<T>(n: number, fn?: (i: number) => T): unknown[] {
  return Array.from({ length: n }, (_, k) => (fn ? fn(k) : k))
}
