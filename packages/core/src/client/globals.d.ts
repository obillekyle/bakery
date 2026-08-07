/**
 * The browser globals, as types.
 *
 * Every name here is bound onto `globalThis` by `client/utils.ts`. This file
 * used to *restate* each one's shape by hand, and four of them had drifted from
 * the code they describe:
 *
 * - `Try.throw` was declared with a synchronous overload it never had
 *   (`tryThrow` is `Promise.try(...).catch(...)`, so it always returns a
 *   Promise) — browser code writing `const n: number = Try.throw(() => 1)`
 *   typechecked and silently received a Promise.
 * - `Case` lost its callable form: the implementation is
 *   `Object.assign(function Case(type, str) {…}, {…})`, so `Case('kebab', s)`
 *   is real but was untypeable.
 * - `request` was `(url, method?, body?)` against an implementation of
 *   `(url, init: RequestJson | string = {}, bodyData?)` — the object-init form
 *   was unreachable from the types.
 * - `randomId` was `() => string` against an implementation taking `length = 8`.
 *
 * So the shapes are no longer restated: each global is a `typeof import(...)`
 * of the module that actually provides it, which fixes all four at once and
 * cannot drift again. `typeof import(...)` inside a `.d.ts` is a type query —
 * it is erased, and adds no runtime module edge into the browser bundle.
 *
 * Two globals genuinely cannot be derived, and stay hand-written:
 * `server` (injected into a Vue SFC's module scope by the compiler, so no
 * module exports it) and `Bakery` (an object literal written inline inside
 * `client/utils.ts`'s `Object.assign(globalThis, …)` call, so there is no
 * exported member to query).
 */
import type { MapOf } from '../types'

declare global {
  /** Server-side exports from `<script server>` — available at runtime in `<script setup>` and templates. */
  const server: { [key: string]: any }

  const matchDefault: typeof import('../utils/isomorphic/match').matchDefault
  var match: typeof import('../utils/isomorphic/match').match
  var is: typeof import('../utils/isomorphic/is').is
  var Try: typeof import('../utils/isomorphic/try').Try
  var tryCatch: typeof import('../utils/isomorphic/try').tryCatch
  var Case: typeof import('../utils/isomorphic/case').Case
  var Math2: typeof import('../utils/isomorphic/math').Math2
  var throws: typeof import('../utils/isomorphic/misc').throws
  var assert: typeof import('../utils/isomorphic/misc').assert
  var any: typeof import('../utils/isomorphic/misc').any
  var repeat: typeof import('../utils/isomorphic/misc').repeat
  var escapeHTML: typeof import('../utils/isomorphic/escape').escapeHtml

  var request: typeof import('./utils').request
  var randomId: typeof import('./utils').randomId

  // Not derivable: written inline in client/utils.ts's Object.assign call
  // rather than exported, so there is no module member to take `typeof` of.
  // Verified against that literal — `version` is the BAKERY_VERSION define,
  // `virtual` is `async virtual(path: string)`, `params` is generic.
  var Bakery: {
    version: string
    virtual(path: string): Promise<any>
    params<T = MapOf<any>>(): T
  }

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
