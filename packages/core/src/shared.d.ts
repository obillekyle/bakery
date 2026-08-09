import type { MapOf } from './types'

/**
 * Ambient types shared by the server and the browser runtime.
 *
 * These used to be declared twice, verbatim, in `global.d.ts` and
 * `client/globals.d.ts`. Nothing caught it: `skipLibCheck: true` suppresses
 * errors *inside* .d.ts files — including this project's own — so four TS2300
 * duplicate-identifier errors sat there invisibly, and every tsconfig excluded
 * `src/client/**` on top of that.
 *
 * Convention 5 is about exactly this: write it once, at the lowest layer that
 * can hold it. `isomorphic.test.ts` pins the same rule for shared *values*
 * because a second copy reappeared there once before; this is the type-level
 * equivalent, and `tests/conventions.test.ts` now fails if a global name is
 * declared in two ambient files again.
 *
 * `MapOf` and `Wrapped` have since moved out of the global scope entirely,
 * into `types.d.ts` — their names are generic enough to collide with a
 * consuming app's own. What stays global here is framework-specific enough
 * not to, and is needed by browser globals that are bound at runtime rather
 * than imported.
 *
 * Anything here must make sense in a browser with no Bun and no server config.
 */

declare global {
  /** The one JSON envelope — see convention 7. */
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
    // `Function` is the type being narrowed to, and there is no narrower
    // spelling of "callable" a predicate can promise. `noBannedTypes` is off
    // repo-wide, so this needs no suppression — see MONOREPO.md for why.
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
    // `Function` again, same reason as the overload above.
    function(value: any): value is Function
  }
}
