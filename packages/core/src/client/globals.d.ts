import type { MapOf, Wrapped } from '../types'

declare global {
  /** Server-side exports from `<script server>` — available at runtime in `<script setup>` and templates. */
  const server: { [key: string]: any }
  const matchDefault: unique symbol
  var match: import('../types').Match<typeof matchDefault>
  var is: ISFunction
  type TryThrow = {
    <T>(callback: () => T, error?: string | Error): T
    <T>(callback: () => Promise<T>, error?: string | Error): Promise<T>
  }
  var Try: {
    <T>(value: Wrapped<T>): T | null
    catch: typeof tryCatch
    return: <T, D>(
      value: Wrapped<T>,
      defaultValue: Wrapped<D, [Error]>,
    ) => T | D
    throw: TryThrow
    silent: <T>(value: Wrapped<T>) => T | null
  }
  var Case: {
    kebab: (str: string) => string
    camel: (str: string) => string
    pascal: (str: string) => string
    snake: (str: string) => string
    upper: (str: string) => string
    lower: (str: string) => string
    caps: (str: string) => string
  }
  var Math2: {
    clamp: (value: number, min?: number, max?: number) => number
    step: (value: number, step: number) => number
  }
  var throws: (message: string | Error) => never
  var assert: (condition: any, message?: string) => asserts condition
  var any: <T = any>(v: any) => T
  var escapeHTML: (str: any) => string
  var repeat: {
    (n: number): number[]
    <T>(n: number, fn: (i: number) => T): T[]
  }
  var tryCatch: <T = any>(
    promise: Wrapped<Promise<T> | T>,
  ) => Promise<[Error, null] | [null, T]> | ([Error, null] | [null, T])

  var Bakery: {
    version: string
    virtual(path: string): Promise<any>
    params<T = MapOf<any>>(): T
  }

  var request: <T = any>(
    url: string,
    method?: string,
    body?: any,
  ) => Promise<JsonResponse<T>>
  var randomId: () => string

  // `ImportMeta.env` is declared once, by global.d.ts's ImportMetaEnv. This
  // file used to redeclare it with an incompatible shape, and to carry
  // verbatim copies of Wrapped / MapOf / JsonResponse / ISFunction — all four
  // now live in shared.d.ts, which is where anything the browser and the
  // server both need belongs.
}

export {}

// A `declare module '@client/utils'` block used to sit here re-exporting
// '../utils'. It never resolved (TS2307 — relative specifiers inside an
// ambient module declaration do not resolve from the containing file), and
// nothing in the codebase imports '@client/utils' from TypeScript: it is a
// runtime importMap entry the browser resolves, mapped to /_client/utils.js.
