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

  interface ImportMeta {
    env: {
      BAKERY_VERSION: string
      WORKER: boolean
      DEV: boolean
      PROD: boolean
      [key: string]: any
    }
  }

  type Wrapped<T, Args extends any[] = []> = T | ((...args: Args) => T)
  type MapOf<T> = { [key: string]: T }
  type JsonResponse<T = any> = {
    time: number
    status: number
    message: string
    data?: T
  }
  type ISFunction = {
    (value: any, type: 'string'): value is string
    (value: any, type: 'number'): value is number
    (value: any, type: 'boolean'): value is boolean
    (value: any, type: 'bigint'): value is bigint
    (value: any, type: 'symbol'): value is symbol
    (value: any, type: 'object'): value is Record<string, any>
    (value: any, type: 'array'): value is any[]
    (value: any, type: 'null'): value is null
    (value: any, type: 'undefined'): value is undefined
    // biome-ignore lint: allow function overload for better type inference when checking for functions
    (value: any, type: 'function'): value is Function
    (value: any, type?: string): boolean
    string(value: any): value is string
    number(value: any): value is number
    boolean(value: any): value is boolean
    bigint(value: any): value is bigint
    symbol(value: any): value is symbol
    object(value: any): value is MapOf<any>
    array(value: any): value is any[]
    null(value: any): value is null
    undefined(value: any): value is undefined
    // biome-ignore lint: 2
    function(value: any): value is Function
  }
}

export {}

declare module '@client/utils' {
  export * from '../utils'
}
