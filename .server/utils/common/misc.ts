export const is = {
  string: (x: any): x is string => typeof x === 'string',
  function: (x: any): x is Function => typeof x === 'function',
  object: (x: any): x is object => x !== null && typeof x === 'object',
  number: (x: any): x is number => typeof x === 'number',
  boolean: (x: any): x is boolean => typeof x === 'boolean',
  array: Array.isArray,
  null: (x: any): x is null => x === null,
  undefined: (x: any): x is undefined => x === undefined,
}

namespace Array2 {
  export function repeat(n: number): number[]
  export function repeat<T>(n: number, fn: (i: number) => T): T[]
  export function repeat<T>(n: number, fn?: (i: number) => T): unknown[] {
    return Array.from({ length: n }, (_, k) => (fn ? fn(k) : k))
  }

  export function from<T>(data: T | T[]): T[] {
    return Array.isArray(data) ? data : [data]
  }
}

export const Math2 = {
  clamp(value: number, min?: number, max?: number): number {
    min ??= -Infinity
    max ??= Infinity
    return Math.min(Math.max(value, min), max)
  },

  step(value: number, step: number): number {
    return Math.round(value / step) * step
  },
}

const repeat = Array2.repeat

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

export function throws(message: string | Error): never {
  throw is.string(message) ? new Error(message) : message
}
