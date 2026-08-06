/**
 * Framework helper types, importable rather than ambient.
 *
 * These were declared in `declare global`, which is fine inside one repo and a
 * hazard the moment the packages are published: the names are generic enough
 * that a consuming app is likely to define its own `MapOf`, and a global type
 * alias cannot be merged or opted out of — the app just gets a redeclaration
 * error with nowhere to put the fix.
 *
 * Moving them cost 24 files an `import type` line and cost consumers nothing:
 * neither app in this repo referenced any of the five, which is the evidence
 * that they were always internal plumbing rather than DX.
 *
 * `verbatimModuleSyntax` makes the compiler reject a value-position import of
 * these, so nothing can accidentally introduce a runtime module edge — which
 * matters because `client/utils.ts` is compiled into the browser bundle.
 */
export type MapOf<T> = { [key: string]: T }

/** A value, or a function producing it. */
export type Wrapped<T, Args extends any[] = []> = T | ((...args: Args) => T)

/** Awaited or not — the shape almost every framework hook returns. */
export type MixedPromise<T> = Promise<T> | T

type ResolveMatchReturn<V, R> = R extends any
  ? R extends (v: V) => infer U
    ? U
    : R
  : never

export type Match<D extends symbol> = {
  default: D
  [Symbol.toPrimitive](hint: string): symbol

  <V, C extends readonly (readonly [any, any])[]>(
    value: V,
    cases: C,
  ): [Extract<C[number][0], D>] extends [never]
    ? ResolveMatchReturn<V, C[number][1]> | undefined
    : ResolveMatchReturn<V, C[number][1]>

  <V extends string, K>(
    value: V,
    cases: Record<string | symbol, K | ((v: V) => K)> & { length?: never },
  ): K

  <V extends string, K>(
    value: V,
    cases: Record<string, K | ((v: V) => K)> & { length?: never },
  ): K | undefined
} & D

export type ResponseFunction<T = any> = (
  req: Request,
  body: T,
  server: Bun.Server<unknown>,
) => Promise<
  string | number | Response | Bun.FileBlob | JsonResponse<any> | void
>

/**
 * The `body` a route module's default export receives: declared params merge
 * over a permissive base. `body.id` is `string` once you declare it, while
 * `body.anythingElse` stays reachable as `any` — the parse rules in
 * `utils/http/body.ts` mean the framework genuinely cannot know every key, so
 * locking the object down would be a lie in the other direction.
 *
 * There is no filename-literal inference (`[id].ts` does not conjure
 * `{ id: string }` on its own — that needs codegen); the contract is that the
 * author declares the shape once, at the `defineRoute` / `html` call, instead
 * of annotating the whole signature or settling for `any`.
 */
export type RouteBody<P = {}> = P & MapOf<any>

/**
 * What a route module may actually return — read off `processResponse`
 * (`router.ts`) and `ApiHandler.handle`: a `Response`, a `BunFile` (streamed
 * with an ETag), the JSON envelope, a plain data object or array (JSON-encoded
 * as-is), a string (HTML-sniffed) or number, or nothing (204; a 404 under
 * `/api/`).
 *
 * Deliberately not `object` (which `Handler.Response` uses): `object` absorbs
 * `Response`, `BunFile` and `JsonResponse` into one member and the union stops
 * saying anything — the same trap `routeTable()`'s dispatch avoids. `MapOf<any>`
 * is the narrowest thing that covers "a plain data object"; a target index
 * signature of `any` does still accept class instances, but that only matters
 * for inference targets — this union is a constraint on what an author may
 * return, and nothing consumes a route module's return type downstream, so the
 * members stay legible instead of collapsing.
 */
export type RouteResponse = MixedPromise<
  | Response
  | Bun.BunFile
  | JsonResponse<any>
  | MapOf<any>
  | readonly unknown[]
  | string
  | number
  | null
  | undefined
  | void
>

/**
 * A typed route module default export. `$dynamic.executeModule` calls it as
 * `(req, body, Bakery.server)` — the third argument is optional here because
 * `Bakery.server` is itself optional before `Bun.serve` runs, and almost no
 * handler wants it.
 *
 * Named `RouteHandler`, not `ApiHandler`: `handlers/routes/api.ts` already
 * exports an `ApiHandler` class (and `$base.ts` a `Handler`), and TSX pages use
 * the same calling convention, so the name should not claim `/api/` either.
 */
export type RouteHandler<P = {}> = (
  req: Request,
  body: RouteBody<P>,
  server?: Bun.Server<any>,
) => RouteResponse
