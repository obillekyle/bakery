# Routing

Bakery has no route table. A URL is resolved to a file on disk, every time, by a
chain of handlers that are asked "can you serve this?" in priority order.

This guide covers page routing. JSON endpoints have their own rules — see
[API routes](api-routes.md).

## The serve root

Everything a page handler resolves is relative to `config.root`, which defaults
to `src` and is resolved to an absolute path at startup
(`packages/core/src/core/config.ts`, `:126`). It is exposed as
`Bakery.serveRoot`.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3000,
})
```

Two other roots exist and are **not** under the serve root:

| Getter | Path | Used by |
| --- | --- | --- |
| `Bakery.serveRoot` | `<cwd>/<config.root>` | pages, API, static files |
| `Bakery.apiRoot` | `<serveRoot>/api` | `ApiHandler` |
| `Bakery.publicRoot` | `<cwd>/public` | `PublicHandler` (`/uploads/*`) |

`publicRoot` is resolved against the working directory, not the serve root
(`packages/core/src/core/bakery.ts`). With the default config that means
`public/`, a sibling of `src/`.

## Three registries, three scales

`Bakery.handlers` holds three independent `HandlerMap`s: `fetch`, `error` and
`websocket`. Each sorts its own members by priority, highest first. **There is
no global ordering** — a number in one registry says nothing about a number in
another.

The `fetch` registry, as populated by `setupServer()`
(`packages/core/src/startup.ts`):

| Priority | Handler | Claims |
| --- | --- | --- |
| 100 | `MiddlewareHandler` | only a request `onRequest` or a middleware answered with a `Response` (see [Middleware](middleware.md)) |
| 95 | `ProxyHandler` | any prefix in `config.proxy` |
| 90 | `VirtualAssetHandler` | `/_client/*`, `/_virtual/*` |
| 87 | `GoogleFontHandler` | `/_gf`, `/_gf/*` |
| 85 | `ImageHandler` | any `.png` `.jpg` `.jpeg` `.webp` `.gif` `.bmp` path |
| 84 | `PublicHandler` | `/uploads/*` |
| 80 | `NMHandler` | `/_nm/*` |
| 70 | `ApiHandler` | `/api/*` |
| 60 | `TSXHandler` | `.tsx` pages |
| 55 | `HTMLHandler` | `.html` pages |
| 50 | `TSHandler` | `.ts` compiled to JS |
| 0 | `StaticHandler` | everything else (fallback) |

Plugins register into the same scale: `DashboardHandler` 120,
`DbExplorerHandler` 115, `AnalyticsHandler` 110, `VueHandler` 58.

`MiddlewareHandler` is the one whose "claims" column is easy to misread. Its
`canHandle` *runs* the whole chain on every request, but returns true only if
`onRequest` or a middleware produced a `Response`
(`packages/core/src/handlers/core/$middleware.ts`) — otherwise the request falls
through to the handler that actually serves it. That is also why it sets
`alwaysResolve`: a request that middleware allows must not be answered from the
route cache next time without middleware running again.

The `error` registry is separate and much smaller: `ApiErrorHandler` 30,
`TSXErrorHandler` 20, `VueErrorHandler` 18, `HTMLErrorHandler` 10,
`DefaultErrorHandler` 0.

The `websocket` registry has no meaningful scale — handlers register without an
explicit priority and get the default of 10 (`$registry.ts`).

## What happens to a request

`handleRequest` (`packages/core/src/router.ts`) runs in this order:

1. **Containment check.** If the path resolves outside the serve root,
   `403 Forbidden`.
2. **WebSocket upgrade.** If `Upgrade: websocket`, the request is routed to the
   `websocket` registry and leaves the pipeline entirely. See
   [WebSockets](websockets.md).
3. **Plugin hooks** — `onRoute`, then `onRequest`. A plugin returning a response
   short-circuits.
4. **The `fetch` registry.** `resolve()` walks handlers highest-priority-first,
   calling `canHandle(path, req)`; the first that says yes wins.
5. **Blocked glob check.** If `config.blocked` matches the path *and* the
   winning handler serves files off disk, `403 Forbidden` as plain text.
   Route-only handlers — middleware, proxy, API — are exempt: the globs exist
   to stop files being served, and testing them before routing made
   `/api/manifest.json` a 403 no config could opt out of.
6. The winning handler's `handle()`.

Whatever a handler returns is normalised by `processResponse`
(`router.ts`): `null`/`undefined` becomes 204, a `Blob`/`BunFile` is streamed
with an ETag, a string is checked for HTML and injected if so, and any other
object is JSON-encoded. The session cookie is *appended* — not set — so a
handler's own `Set-Cookie` survives.

## How a URL becomes a file

`getRoute` (`packages/core/src/handlers/core/$routing.ts`) does the
resolution. It splits the path on `/`, walks down directories, and at the last
segment scans the directory with globs. The rules, in the order they apply:

**1. An empty path segment means `index`.** `/` looks for `index.<ext>`, and
`/blog` first tries `blog.<ext>`, then falls back to `blog/index.<ext>`.

```
src/index.html          →  /
src/example/index.html  →  /example
```

**2. Static files are scanned before dynamic ones.** `resolveRoute`
(`$dynamic.ts`) runs a `staticOnly` pass first, then consults the dynamic
cache, then a `dynamicOnly` pass. Within one handler an exact file always beats
a `[param]` file.

**3. The extension in the URL is a hint, not a requirement.** If the URL carries
an extension that is not one the handler owns, the handler retries with its own
extension on the same stem (`$routing.ts`). Verified against the example
app:

```
/blog/existing        →  src/blog/existing.tsx   (TSXHandler)
/blog/existing.html   →  src/blog/existing.tsx   (TSXHandler — still)
/script/index.js      →  src/script/index.ts     (TSHandler)
```

This is why `/blog/existing.html` renders the `.tsx` page: `TSXHandler` is asked
first, and it treats `existing.html` as "the stem `existing`, plus an extension I
should ignore".

**4. `[param]` segments become a regex with an optional trailing extension.**
`getDynamicRoute` (`$base.ts`) turns `blog/[id].html` into
`^/blog/([^/]+?)(?:\.([a-z]*))?$`, so both `/blog/123` and `/blog/123.html`
match and bind `id = "123"`.

**5. A path containing literal brackets is refused.** `DynamicHandler.canHandle`
returns false for any path spelled like a route template — `[\w$]` in brackets,
or the `[...name]` catch-all form (`$dynamic.ts`) — so a client cannot request
`/blog/[id]` or `/docs/[...slug]` directly.

**6. `[...name]` catches every deeper path.** A terminal `[...name]` segment
matches one *or more* remaining segments: `docs/[...slug].tsx` answers
`/docs/a` and `/docs/a/b/c`, binding `slug = ["a"]` and
`slug = ["a", "b", "c"]` — an array of the remaining segments, in order.
Three rules keep it predictable (`$base.ts`, `$routing.ts`, `$dynamic.ts`):

- **It is always the weakest route.** An exact file, a single-param sibling
  (`docs/[id].tsx`), a child index (`docs/a/index.tsx`) and a deeper catch-all
  (`docs/guides/[...rest].tsx`) all win first. Only what nothing else claims
  falls through to it.
- **A real file always wins — even across handlers.** When the requested path
  names an existing file, the catch-all declines *before* answering, so the
  file's own handler serves it even when that handler has lower priority:
  `docs/style.css` next to `docs/[...slug].tsx` is served by `StaticHandler`
  (priority 0), not rendered by the page (priority 60). This is the one
  exception to "priority beats specificity", deliberately scoped to
  catch-alls: a single-param `[id].tsx` keeps the documented behavior and
  does claim `/docs/style.css`. Directories are not files — a path naming a
  directory with no index still falls to the catch-all.
- **It never claims its own directory — unless you ask with `!`.** `/docs` is
  not matched by `docs/[...slug].tsx`: the pattern requires at least one rest
  segment, so a bare `/docs` still means `docs/index.*` or a 404. The
  `docs/[...slug!].tsx` spelling opts into the bare directory, binding
  `slug = []` there — and an `index` sibling still wins it, because static
  discovery runs before dynamic. The empty array is also what makes "no rest"
  distinguishable from any real path.
- **Only terminal, and only a filename.** `[...slug]` anywhere but the last
  segment makes the file inert (nothing may follow a catch-all), and a
  *directory* named `[...slug]/` routes nothing at all — discovery matches
  files only, so `[...slug]/index.html` is dead weight.

One inherited limitation: params mix freely within the final filename's
pattern, but discovery never descends bracket-named *directories* — neither
`[id]/[...slug].tsx` nor `[category]/[slug].tsx` is reachable, because the
segment walk resolves literal directory names only (`$routing.ts`). Dynamic
folders have never been discoverable; catch-alls do not change that.

The catch-all works in every dynamic handler — `api/[...path].ts` gives you a
single endpoint for an entire API subtree, and pairs with the middleware guide's
interception patterns for gateway-style routing.

### Priority beats specificity across handlers

Rule 2 only orders candidates *inside* one handler. Between handlers, the
priority number wins — and it is checked before the other handler is ever asked.

Given both of these files:

```
src/shop/[id].tsx     ← dynamic, TSXHandler (60)
src/shop/sale.html    ← exact, HTMLHandler (55)
```

`/shop/sale` is served by `shop/[id].tsx`. `TSXHandler` is consulted first, finds
a dynamic match, and `HTMLHandler` is never asked. If you want the exact file to
win, give it the higher-priority extension (`shop/sale.tsx`) rather than relying
on it being more specific.

## Page handlers

A `.tsx` page's default export is called with `(req, body)` — the parsed body and
the route params merged together (`$dynamic.ts`, `tsx.ts`). Route params
are applied last, so a param named `id` overwrites a query string `?id=`.

```tsx
import { createElement, HTMLBody } from '@bakery-framework/core'

// src/blog/[id].tsx — declare the param once and body.id is a string, not any
export default HTMLBody<{ id: string }>((req, body) => (
  <html lang="en">
    <head>
      <title>Post {body.id}</title>
    </head>
    <body>
      <h1>Post {body.id}</h1>
      <p>Query: {new URL(req.url).searchParams.toString() || 'none'}</p>
    </body>
  </html>
))
```

A catch-all page declares its param the same way — the value is the joined
rest of the path:

```tsx
import { createElement, HTMLBody } from '@bakery-framework/core'

// src/wiki/[...page].tsx — one file for /wiki/<anything>, however deep
export default HTMLBody<{ page: string }>((req, body) => (
  <main>
    <h1>{body.page.split('/').join(' › ')}</h1>
  </main>
))
```

`HTMLBody` (exported as both `html` and `HTMLBody` from `@bakery-framework/core`) wraps the
render function: it stringifies the result, prepends `<!DOCTYPE html>` when the
markup starts with `<html`, and otherwise wraps loose markup in a minimal
document (`core/jsx.ts`). It also passes `Bakery.server` as a third argument,
which the bare form does not.

The type parameter is optional and type-level only — `HTMLBody(render)` without
one behaves exactly as before, with `body` as a permissive map. Declared keys
type over that base (`RouteBody` in `@bakery-framework/core`), so undeclared params and
query fields stay reachable. API routes get the same treatment through
`defineRoute` — see [API routes](api-routes.md#the-signature).

You do not have to use it. A default export returning a string works, and so
does one returning a `Response`, a `BunFile`, or a plain object (encoded as
JSON):

```tsx
export default function Home() {
  return (
    <html lang="en">
      <head>
        <title>Starter</title>
      </head>
      <body>
        <h1>Bakery starter</h1>
      </body>
    </html>
  )
}
```

JSX children are escaped unless they came from `createElement` itself
(`core/jsx.ts`), so interpolating user data is safe by default. Use `raw()`
from `@bakery-framework/core/core/jsx` to opt a string out.

### Sibling `.ts` and `.css` files are auto-injected

If `page.tsx` has a `page.ts` next to it, a `<script src="/page.js" type="module">`
is appended to the body; a `page.css` becomes a `<link rel="stylesheet">` in the
head (`tsx.ts`). Nothing to configure.

### Params in plain HTML

Static `.html` pages cannot run server code, so params arrive two ways
(`utils/http/html.ts`, `utils/http/dom.ts`):

- `{{id}}` or `{{id, fallback}}` in the markup is substituted server-side and
  HTML-escaped.
- `window.__PAGE_PARAMS__` is injected as a script tag; the browser runtime
  exposes it as `Bakery.params()`.

Keys starting with `$$` are stripped before injection.

## Error pages

An error goes through `handleRequestError` (`router.ts`): plugin `onError`
hooks first, then `config.onError` (a returned `Response` wins), then the `error`
registry, then `DefaultErrorHandler` as a floor.

`DynamicErrorHandler.resolveRoute` (`$error.ts`) walks *up* from the failed
path's directory, trying `error-<code>` then `error` at each level:

```
request /blog/nope     →  src/blog/error-404.tsx
                       →  src/blog/error.tsx
                       →  src/error-404.tsx
                       →  src/error.tsx
                       →  DefaultErrorHandler
```

The `.tsx` variants are tried before `.html` because `TSXErrorHandler` is 20 and
`HTMLErrorHandler` is 10. Requests under `/api/` are claimed first by
`ApiErrorHandler` (30), which always answers with the JSON envelope rather than a
page.

A handler returning a `Response` with status ≥ 400 is routed into this chain too,
not just a thrown error (`packages/cli/src/worker.ts`). That is how a 404
from `StaticHandler` reaches your `error-404.html`.

## Adding your own handler

Anything that serves a request is a `Handler` subclass registered with a
priority. There is no other extension point.

```ts
import { Bakery, response } from '@bakery-framework/core'
import { Handler } from '@bakery-framework/core/handlers'

export class HealthHandler extends Handler {
  static override canHandle(path: string) {
    return path === '/healthz'
  }

  static override handle() {
    return response.json.success('ok')
  }
}

Bakery.handlers.fetch.set(HealthHandler, 90)
```

`canHandle` receives `(path, req)` and may be async. Everything is static —
handlers are never instantiated. Register from a plugin's `setup()`; see
[Plugin API](../plugins/plugin-api.md).

To serve files from a directory outside the serve root, register a mount instead
of writing a handler. `mountRoutes(prefix, dir)`
(`packages/core/src/handlers/core/$mounts.ts`) makes the normal handler chain —
routing, compilation, caching, containment — treat that directory as if it were
part of the app.

## Caching, and when it bites

Two layers cache route resolution:

- **Per-handler** `cache` / `dynamicCache` (LRU, `$base.ts`), keyed by
  `hostKey(path)` so multi-host apps do not share entries. Cleared by
  `initRoutes()`.
- **`HandlerMap.routeCache`** (`$registry.ts`), a process-wide LRU mapping
  `(registry, hostname, path)` to the handler that won last time.

`HandlerMap.routeCache` is **not** cleared by `initRoutes()` — it is never
cleared anywhere. On a cache hit, `resolve()` calls only the cached handler's
`canHandle` and returns it if still true, skipping every higher-priority handler
(`$registry.ts`). See [Middleware](middleware.md#the-route-cache-does-not-skip-middleware)
for the consequence, which is the sharpest edge in the framework.

In development, edits to `server.config.ts` or anything under the api directory
restart the dev worker outright (`compiler/dev-service.ts`), which is what
makes the problem invisible while you are working on those files. `.tsx` edits
no longer restart the process — they clear the per-handler caches only, and
`HandlerMap.routeCache` survives them.

## Reserved paths

`/_*` and `/api/_*` belong to the framework and its plugins, and `__bakery.`
prefixes framework session keys. Do not create app routes under those prefixes.

This is the complete set in use today. Core's entries always exist; a plugin's
only exist when that plugin is installed.

| Path | Served by | Registered by |
| --- | --- | --- |
| `/_client/*`, `/_virtual/*` | framework browser runtime | core (`VirtualAssetHandler`) |
| `/_gf`, `/_gf/*` | Google Fonts, proxied and cached to disk | core (`GoogleFontHandler`) |
| `/_nm/*` | `node_modules`, bundled on demand | core (`NMHandler`) |
| `/_livereload` | the live-reload WebSocket — **development only** | core (`LiveReloadHandler`) |
| `/_dashboard`, `/_dashboard/dashboard.js`, `/api/_dashboard`, `/api/_dashboard/*` | admin console | `@bakery-framework/plugin-dashboard` |
| `/_db`, `/_db/*`, `/api/_db`, `/api/_db/*` | database explorer | `@bakery-framework/plugin-db-explorer` |
| `/_analytics/ping`, `/api/_analytics/stats`, `/api/_analytics/reset` | telemetry endpoints | `@bakery-framework/plugin-analytics` |
| `/_analytics_ws` | telemetry WebSocket | `@bakery-framework/plugin-analytics` |
| `/_vue/*` | compiled SFC chunks and the Vue runtime | `@bakery-framework/plugin-vue` |

Two of these are namespace *roots*, not string prefixes: `DashboardHandler`
matches `/_dashboard` and `/api/_dashboard` exactly or a segment below them, so
an application route named `/api/_dashboard-export` is yours, not the plugin's
(`packages/plugins/dashboard/src/setup.ts`).

The analytics collector additionally treats *any* path beginning `/_` as an
asset and leaves it out of page-hit counts
(`packages/plugins/analytics/src/core.ts`), so an app route under `/_` would
also go uncounted even where nothing claims it.

`/api/*` and `/uploads/*` are reserved in a different sense — they are ordinary
app-servable prefixes owned by `ApiHandler` and `PublicHandler`. See
[Project structure](../getting-started/project-structure.md#reserved-url-prefixes).

The default blocked globs (`packages/core/src/utils/constants.ts`) also make a
number of files unreachable from file-serving handlers regardless of where they
sit — every `.yaml`, `.yml`, `.sql`, `.db` and `.lock` file, plus the named
project JSON files (`package.json`, `tsconfig.json` and friends; there is
deliberately no blanket `.json` ban). See
[Static assets](static-assets.md#what-is-never-served).
