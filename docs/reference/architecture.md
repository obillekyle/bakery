# Architecture

How a Bakery process starts, and how a request becomes a response.

## Packages

| Package | Depends on | Contents |
| --- | --- | --- |
| `@bakery-framework/core` | nothing at runtime | handlers, router, config, sessions, caches, logger, compiler, JSX |
| `@bakery-framework/orm` | core | query builder, mutations, adapters, schema sync, backup |
| `@bakery-framework/cli` | core; orm as an *optional peer* | the `bakery` binary; process-mode dispatch |
| `@bakery-framework/plugin-vue` | core | `.vue` components with server blocks |
| `@bakery-framework/plugin-analytics` | core | request telemetry |
| `@bakery-framework/plugin-dashboard` | core, orm | the admin console |

Core depending on nothing is a rule, not an accident: it is why escaping
helpers live in core and are re-exported by the Vue plugin rather than the
other way round. The `@server/*`, `@database/*` and `@plugins/*` aliases that
older material refers to no longer exist.

## Four process modes

`packages/cli/src/index.ts` is a **dispatcher, not a server**. Reading it will
not tell you where requests are served; it inspects the mode flags and hands
off to one of four files.

| Mode | Invocation | Entry chain |
| --- | --- | --- |
| dev master | `bun run dev` | `index.ts` → `watcher.ts` → `compiler/dev-service.ts` |
| dev worker | `--dev-worker` (spawned by the master) | `index.ts` → `dev.ts` → `worker.ts` |
| production | `bun run start` | `index.ts` → `prod.ts` → `worker.ts` |
| cluster | `--threads N` (production only) | `index.ts` → `threads.ts` → N × `worker.ts` |

Flags:

- `--sync` / `-s` runs schema sync before dispatch. It is skipped in the dev
  and thread workers, which are spawned by a master that already ran it — and
  it doubles as the force flag for the dev worker's own hash-gated sync.
- `--threads N` / `-t N` forks a cluster. It is ignored under `--dev`. On any
  platform other than Linux it is clamped to 1 with a warning, because
  `SO_REUSEPORT` load balancing is Linux-only; `THREAD_ID` 0 owns the startup
  banner, and a cluster of one behaves identically to plain production.

### The mode flags themselves

`core/init.ts` defines `DEV`, `PROD`, `WORKER`, `DEV_WORKER`, `THREAD_WORKER`,
`THREAD_ID`, `TEST` and `MODE` as getters on `process.env`, and binds the JSX
globals (`createElement`, `Fragment`, `html`) onto `globalThis`. Everything
downstream branches on those flags, and the classic JSX runtime resolves its
factory names in global scope — so **`core/init.ts` must be the first import in
every entry file**.

### Boot order

`dev.ts` and `prod.ts` differ only at the edges:

```
initConfig()          load and freeze server.config.ts
PluginHooks.setup()   plugins register handlers, mounts, hooks
initImportMap()       + per-host import maps
syncTSConfigPaths()   dev only
SyncService.run()     dev: when the schema hash changed (--sync forces);
                      production: only with --sync
initDB()              production only here; the worker calls it again
→ worker.ts
```

`bun run dev` and `bun run start` are thin wrappers over the `bakery` bin, with
`--dev` for the first. Run them from the application directory — `Bakery.root`
is the process cwd, so running from a parent silently serves a different app.

`worker.ts` then calls `setupServer()` ([`startup.ts`](../../packages/core/src/startup.ts)),
which populates the three handler registries, runs plugin `setup()`, and warms
the route caches — after which `Bun.serve` starts and `runStartupBanner()`
prints the URLs (plus a rate-limit line when the default limiter is in effect,
and a restatement of any DEV config-load error) and fires `onStart`.

`PluginHooks.setup()` has two call sites — `dev.ts`/`prod.ts` before the import
map is built, and `setupServer()` for cluster workers that pass through neither
entry — but both route through one memoised `setupPlugins()`, so plugin
`setup()` runs **exactly once per process**
([`startup.ts`](../../packages/core/src/startup.ts)).

**`worker.ts` is the only file in the framework that owns a `Bun.serve`.** That
is checked by [`tests/conventions.test.ts`](../../tests/conventions.test.ts).

## The request path

Per request, `worker.ts` does the following
([`packages/cli/src/worker.ts`](../../packages/cli/src/worker.ts)):

1. `getHostname(req)` — `X-Forwarded-Host` when `trustProxy` is set, else the
   `Host` header, else the URL.
2. `resolveHostConfig(hostname)` and `hostStore.run(...)` — an
   `AsyncLocalStorage` scope carrying that host's config for the whole request.
3. `req.startNs`, and a lazily-created `req.session`.
4. Rate limiting (on by default; `rateLimit: false` disables): a token bucket
   in a `SharedArrayBuffer`, keyed by `keyBy(req)` or the client IP, hashed
   into 1024 slots and therefore shared across cluster workers. Over budget →
   429 with a `Retry-After` header; rejection logging is sampled per key.
5. `handleRequest(req)`.
6. If the result is a `Response` with status ≥ 400, or an object carrying
   `errorCode`, `handleRequestError(...)` takes over.
7. `processResponse(result, req)` serialises whatever came back.

### `handleRequest`

[`router.ts`](../../packages/core/src/router.ts), in order:

1. Path containment against the serve root (`fs.isForbidden`) → 403.
2. `Upgrade: websocket` → the websocket registry decides; success returns the
   `WS_UPGRADE` symbol, failure a 400.
3. `PluginHooks.onRoute(req)` — observation only, return value ignored.
4. `PluginHooks.onRequest(req)` — a non-nullish return short-circuits.
5. `Bakery.handlers.fetch.resolve(path, req)` — the registry below; no
   handler → 404.
6. `blocked` glob match → 403, but only when the resolved handler serves
   files off disk. Route-only handlers — middleware, proxy, API — are exempt,
   which is what keeps `/api/manifest.json` routable.
7. `handler.handle(path, req)`.

### Ambient config

`Bakery.config` is a **getter** that reads the current `hostStore` entry and
falls back to the process config. Multi-host configuration is therefore ambient,
not threaded through call arguments: `Bakery.serveRoot` inside a handler is the
current host's root. `hostKey(path)` prefixes a cache key with the current
hostname, which is how per-host caching stays correct in one process.

## Three registries

There are **three independent registries**, each with its own priority scale.
Higher runs first. There is no single global ordering — a fetch handler at 90
and an error handler at 20 are not comparable.

`HandlerMap.resolve` walks its list in priority order, asks each handler's
`canHandle(path, req)`, and caches the winner per `(registry, host, path)` in a
shared LRU; the cached handler is re-validated with `canHandle` on every hit.

### `Bakery.handlers.fetch`

Registered in [`startup.ts`](../../packages/core/src/startup.ts); plugin
entries are marked.

| Priority | Handler | Claims |
| --- | --- | --- |
| 120 | `DashboardHandler` *(plugin)* | `/_dashboard`, `/_dashboard/dashboard.js`, `/api/_dashboard*` |
| 110 | `AnalyticsHandler` *(plugin)* | `/_analytics/ping`, `/api/_analytics/{stats,reset}` |
| 100 | `MiddlewareHandler` | claims a request only when `onRequest` or a middleware returned a `Response` |
| 95 | `ProxyHandler` | any configured `proxy` prefix |
| 90 | `VirtualAssetHandler` | `/_client/*`, `/_virtual/*` |
| 87 | `GoogleFontHandler` | `/_gf/*` — proxied and cached Google Fonts |
| 85 | `ImageHandler` | image extensions, with `;<size>` resizing |
| 84 | `PublicHandler` | `/uploads/*` |
| 80 | `NMHandler` | `/_nm/*` — bundled `node_modules` output |
| 70 | `ApiHandler` | `/api/*` |
| 60 | `TSXHandler` | `.tsx` routes |
| 58 | `VueHandler` *(plugin)* | `.vue` routes |
| 55 | `HTMLHandler` | `.html` routes |
| 50 | `TSHandler` | `.ts` routes |
| 0 | `StaticHandler` | everything — `canHandle` returns `true` |

`StaticHandler` at 0 with an unconditional `canHandle` is the fallback, which
is why a handler registered at a priority below it would never run.

`MiddlewareHandler` is unusual: its `canHandle` *runs* the middleware chain and
stores any resulting `Response` in a per-request `WeakMap`, so `handle` can
return it without re-running. A middleware that throws produces a 500 rather
than falling through — an auth check that errors must not admit the request.

### `Bakery.handlers.error`

| Priority | Handler | Renders |
| --- | --- | --- |
| 30 | `ApiErrorHandler` | JSON envelope for `/api/*` |
| 20 | `TSXErrorHandler` | `error.tsx`, `error-*.tsx` |
| 18 | `VueErrorHandler` *(plugin)* | `error.vue`, `error-*.vue` |
| 10 | `HTMLErrorHandler` | `error.html`, `error-*.html` |
| 0 | `DefaultErrorHandler` | the built-in error page |

`handleRequestError` ([`router.ts`](../../packages/core/src/router.ts))
normalises the thrown value into `{errorCode, errorText, errorBody}`, then
tries, in order: every plugin's `onError`, the config's `onError`, this
registry, and finally `DefaultErrorHandler`.

### `Bakery.handlers.websocket`

Registered without explicit priorities: `LiveReloadHandler` (dev worker only,
`/_livereload`) and `AnalyticsWSHandler` (`/_analytics_ws`).

The upgrade is decided in `canHandle`, before any plugin hook runs — which is
why a socket needing authorization has to check there rather than in `open`.
`WebSocketHandler.handle` stashes the handler class, the path, the hostname and
the host config on `ws.data`, so every socket callback can re-enter the correct
host context.

## The handler contract

```ts no-check — the shape; `Handler` is never instantiated, so these are statics
class MyHandler extends Handler {
  static canHandle(path: string, req: Request): boolean | Promise<boolean>
  static handle(path: string, req: Request): Handler.Response
  static initRoutes(): void | Promise<void>   // optional; clears caches at boot
}
```

`Handler.Response` is deliberately wide: `Response | Bun.BunFile | string |
object | undefined | void`, sync or async. `processResponse` knows how to
serialise each.

`DynamicHandler` extends this for file-backed routes: it resolves a URL to a
file under a configured directory and extension set, supports `[param]`
segments and extensionless URLs, and caches both static and dynamic resolutions.
`ApiHandler`, `TSXHandler`, `HTMLHandler`, `TSHandler` and `VueHandler` are all
`DynamicHandler`s.

Literal file lookups go through `getStatic`
([`handlers/core/$static.ts`](../../packages/core/src/handlers/core/$static.ts)),
which is the single place that answers "which file is at this path, and am I
allowed to serve it" — checking route mounts, prefix containment, `.forbidden`
markers and the blocked globs. Four handlers used to spell that out separately,
in four slightly different ways.

## `processResponse`

[`router.ts`](../../packages/core/src/router.ts). One funnel, so every
response is treated the same way:

| Returned | Becomes |
| --- | --- |
| `WS_UPGRADE` symbol | nothing — Bun owns the socket |
| `null` / `undefined` | 204 |
| `Response` | passed through, with head/body injection if HTML |
| `Blob` / `Bun.BunFile` | `ETag.sendFile` — content type from the file, ETag attached |
| `string` | HTML injection if it looks like HTML, else `text/plain` |
| `JsonResponseData` | the envelope `{time, status, message, data}`, `time` stamped here |
| any other object | `JSON.stringify` |

Then the session cookie is **appended** (never set — a handler may already have
issued its own `Set-Cookie`), and `ETag.sendResponse` applies conditional-GET
handling.

This is why convention 7 holds: there is exactly one JSON envelope, because
there is exactly one place that writes one.

## Where the pieces live

```
packages/core/src/
  startup.ts     registry population + banner — the map of the request surface
  router.ts      handleRequest / handleRequestError / processResponse / serveWebSocket
  session.ts     cookie sessions over the tiered cache
  handlers/
    core/        $base, $registry, $routing, $static, $mounts, $dynamic,
                 $error, $middleware, $websocket
    assets/      static, image, public, nm, google-font, virtual-asset, ts, tsx
    routes/      api, html, proxy, livereload
  core/          bakery.ts (service locator), config.ts, plugins.ts, jsx.ts,
                 init.ts, context.ts
  utils/
    isomorphic/  pure — no Bun.*, no node builtins, no DOM; compiled into the
                 browser bundle as-is
    common/      re-export shims over isomorphic/ + server-only helpers
    http/        response, html, dom, etag, csrf, escape, body, ip
  client/        browser runtime
  cache/         lru, tiered, string, shared-db
  logger/        logger + declared message tables + client registry
  plugins/       types.ts (ServerPlugin, definePlugin) + routes.ts (routeTable)

packages/cli/src/   index (mode dispatch), watcher, dev, prod, threads, worker
packages/orm/src/   adapters/, orm/, sync/, backup, registry
packages/plugins/{vue,analytics,dashboard}/src/
apps/example/       the bundled example app
```

The three-layer split under `utils/` is load-bearing: `isomorphic/` is compiled
into the browser bundle unchanged, so it may not touch `Bun.*`, node builtins
or the DOM. Write logic once, at the lowest layer that can hold it. `case.ts`
is the worked example — `Case` is isomorphic, `toHash` stays server-side
because it calls `Bun.hash`.

## Related

- [Plugin API](../plugins/plugin-api.md) — registering into these registries.
- [CLI](cli.md) — the flags in full.
