/**
 * Declarative endpoint tables for plugins.
 *
 * The dashboard already used a `Record<path, handler>` map; analytics used a
 * hand-rolled `if (path === … && method === …)` chain. This generalises the
 * dashboard's shape — the one that was already working — so a third plugin does
 * not arrive with a fourth style of dispatch.
 *
 * Scope is deliberately narrow: exact-match paths only, no params or wildcards.
 * Anything needing those belongs in the core router (`DynamicHandler`), not in
 * a parallel implementation here.
 */

import { checkCsrf, checkSameOrigin } from '../utils/http/csrf'
import { response } from '../utils/http/response'
import type { ValidResponses } from './types'

/**
 * Handlers may return anything the router knows how to serialize — the
 * dashboard's return `JsonResponseData` and `BunFile` as well as `Response`.
 * `ValidResponses` (= `Handler.Response`) is the framework's name for that set.
 */
export type PluginRoute = (req: Request, url: URL) => ValidResponses

/**
 * Keys are either a bare path (`'/api/_x/stats'`, matching any method) or a
 * method-qualified path (`'POST /api/_x/reset'`). A method-qualified entry wins
 * over a bare one for the same path.
 *
 * The two forms are guarded differently — see `guardFor` below. A bare key is
 * same-origin-only; a method-qualified one gets the ordinary CSRF check.
 */
export type PluginRouteTable = Record<string, PluginRoute>

/**
 * What a dispatch built from `T` actually resolves to: the union of that
 * table's own handler return types, awaited, with the `undefined`/`void` cases
 * replaced by `null` — exactly what `dispatch` does at runtime with `?? null`.
 *
 * Keyed on the table type rather than flattened to `ValidResponses` because
 * `ValidResponses` contains `object`, which absorbs `Response`, `Bun.BunFile`
 * and `JsonResponseData` back into one useless member. Declaring a table with
 * `satisfies PluginRouteTable` (rather than annotating it) keeps the literal
 * type, and with it the precision.
 */
export type PluginRouteResult<T extends PluginRouteTable> =
  | Exclude<Awaited<ReturnType<T[keyof T]>>, undefined | void>
  // The 403 `dispatch` answers with when the request fails the guard below.
  // Spelled out rather than smuggled through: a dispatch can return something
  // no endpoint in the table declares, and the caller should have to see that.
  | Response
  | null

/**
 * How hard `dispatch` guards a match, by how much the table declared.
 *
 * A **method-qualified** key (`'POST /api/_x/reset'`) is an author who thought
 * about methods, so it gets the ordinary `checkCsrf`: safe methods through,
 * unsafe ones same-origin. `'GET /api/_x/public'` is therefore also the way to
 * declare an endpoint that *is* meant to answer cross-origin.
 *
 * A **bare** key matches every method, which means the author did not say —
 * and that is exactly how the dashboard's mutating endpoints ended up
 * answering a `GET`. `checkCsrf` is no help there: it waves GET through by
 * definition, so a cross-site `<img src="/api/_dashboard/execute-action">`
 * arrives with the session attached and runs. A bare key therefore gets the
 * stricter `checkSameOrigin`, on every method: the request must not come from
 * another site whatever verb it used.
 *
 * The result is that a plugin cannot forget CSRF by omission. Forgetting to
 * name the method now costs cross-origin reachability rather than the guard.
 */
function guardFor(qualified: boolean) {
  return qualified ? checkCsrf : checkSameOrigin
}

export function routeTable<T extends PluginRouteTable>(routes: T) {
  /**
   * Declared as an overload — the same shape `handleRequest` uses in
   * `router.ts`. The signature carries the precise per-table union; the
   * implementation only ever sees the `PluginRoute` *constraint*, so on its own
   * it could infer no better than the wide `ValidResponses`.
   */
  function dispatch(req: Request, url?: URL): Promise<PluginRouteResult<T>>
  async function dispatch(req: Request, url: URL = new URL(req.url)) {
    const path = url.pathname
    const qualified = `${req.method} ${path}`

    // hasOwn, not plain indexing: a bare `routes[path]` lookup would reach
    // inherited Object.prototype members for a suitably named path.
    const isQualified = Object.hasOwn(routes, qualified)
    const handler = isQualified
      ? routes[qualified]
      : Object.hasOwn(routes, path)
        ? routes[path]
        : undefined

    if (!handler) return null

    // Runs after the match and before the handler, so an unmatched path still
    // resolves to `null` and falls through to the rest of the router rather
    // than being claimed by a 403.
    const denied = guardFor(isQualified)(req, url)
    if (denied) return response.error('Forbidden', 403)

    return (await handler(req, url)) ?? null
  }

  return dispatch
}
