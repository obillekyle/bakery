# Middleware

Middleware in Bakery is a `Handler` like everything else. `MiddlewareHandler`
sits at priority 100 in the `fetch` registry — the top — and runs the functions
you declared in config (`packages/core/src/startup.ts`).

Read the [route cache](#the-route-cache-skips-middleware) section before you use
middleware for authorisation. It does not do what you will assume.

## Declaring it

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',

  onRequest(req) {
    // runs first, before the array
  },

  middleware: [
    (req, server) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith('/admin') && !isAdmin(req)) {
        return new Response('Forbidden', { status: 403 })
      }
    },
  ],
})

function isAdmin(_req: Request) {
  return false
}
```

Two hooks, and they do not behave the same way:

- `config.onRequest(req)` runs first, before the array. See the warning below —
  it can only short-circuit with an **HTML** response.
- `config.middleware` is an array of `(req, server) => Response | void`, run in
  declaration order. **Only a `Response` stops the chain** — returning a string,
  an object or `true` is ignored and the next middleware runs
  (`$middleware.ts`).

If nothing returns a `Response`, `canHandle` reports false and the request
continues down the registry to the page, API or asset handler that owns it.

Returned responses go through HTML injection, so a middleware that returns a full
HTML document still gets the import map, live-reload script and configured
`head`/`body` fragments.

### `onRequest` drops non-HTML responses

```ts no-check — an excerpt of framework internals, quoted for reference
const intercepted = await Bakery.config.onRequest(req!)
if (intercepted) return (await injectIfHtml(intercepted)) || undefined
```

`injectIfHtml` returns `null` for anything that is not HTML
(`utils/http/html.ts`), and the `|| undefined` turns that into "no
response" — so the request **continues** as if the hook had returned nothing
(`$middleware.ts`).

Confirmed by running the handler directly:

| `config.onRequest` returns | result |
| --- | --- |
| `new Response('Forbidden', { status: 403 })` | `undefined` — request proceeds |
| the same response with `content-type: text/html` | 403, request stops |

A plain-text 403, a JSON error, a redirect — all silently discarded. This is a
fail-open bug in a hook shaped exactly like an auth check. Use `config.middleware`
for anything that must reject a request; the array path keeps the original
response when injection declines it (`$middleware.ts`).

## A throw is a 500, deliberately

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  middleware: [
    async req => {
      const session = await lookupSession(req) // throws if the store is down
      if (!session) return new Response('Unauthorized', { status: 401 })
    },
  ],
})

async function lookupSession(_req: Request): Promise<object | null> {
  return null
}
```

If `lookupSession` throws, the request gets a 500 and stops
(`$middleware.ts`). It is not logged-and-ignored. Middleware is where auth
checks live, and treating a crashed check as "no opinion" would let the request
through — the framework fails closed instead.

This matches the wider convention: guards return the rejection, they do not throw
for an expected denial, and an indeterminate state is a denial.

## The route cache skips middleware

**Your middleware runs on the first request to a given path and then stops
running for that path.** This is a bug in the framework, not a design choice, but
it is the behaviour today and it is silent.

`HandlerMap.resolve` (`packages/core/src/handlers/core/$registry.ts`)
remembers which handler won for a `(registry, hostname, path)` key. On a later
request it asks *only that handler* whether it still applies, and returns it
without consulting anything above it:

```ts no-check — an excerpt of framework internals, quoted for reference
const cached = HandlerMap.routeCache.get(pathId)
if (cached) {
  if (await cached.canHandle(path, ...params)) return cached
  HandlerMap.routeCache.delete(pathId)
}
```

`MiddlewareHandler` only gets cached when it actually produces a response. So the
common case — middleware inspects the request and lets it through — caches
whatever handler served the page, and from then on `MiddlewareHandler.canHandle`
is never called for that path.

Confirmed directly: with a middleware-like handler at 100 and a page handler at
60, three requests to the same path invoke the first handler's `canHandle`
exactly once.

The failure mode is worse than "runs once", because a guard that *rejects* keeps
working. While every request to `/admin` is denied, `MiddlewareHandler` stays the
cached handler and is re-consulted each time. The first request it lets through
evicts it and installs the page handler — after which nobody is checked again.
So the guard tests green, works in staging, and stops the moment one legitimate
user signs in.

`HandlerMap.routeCache` is a plain LRU with no TTL (`cache/lru.ts`), 5000 entries
(500 in a thread worker), and nothing clears it — `initRoutes()` clears the
per-handler caches only (`packages/core/src/cache/index.ts`). An entry survives
until it is evicted by volume or the process restarts.

What this means for you:

- **Do not put authorisation in `config.middleware`.** Put it in the route that
  needs it, or in a plugin `onRequest` hook — `PluginHooks.onRequest` is called
  by `handleRequest` directly on every request (`router.ts`) and is not
  subject to the registry cache. Registering your own `Handler` does not help;
  it is in the same registry and behind the same cache.
- Middleware that only needs to run once per path — priming a cache, logging a
  first hit — is unaffected.
- In development the problem hides: edits to `server.config.ts` or anything
  under the api directory restart the dev worker
  (`compiler/dev-service.ts`), which empties the cache. `.tsx` edits no longer
  restart the process, so they no longer mask it. It reappears the moment you
  stop editing, and in production it is permanent.

## WebSocket upgrades never reach middleware

`handleRequest` checks for `Upgrade: websocket` and dispatches to the `websocket`
registry *before* the plugin hooks and before the `fetch` registry
(`packages/core/src/router.ts`). Middleware is in the `fetch` registry, so
it does not run at all for an upgrade.

Authorise the socket in the handler's own `canHandle`. The analytics plugin does
exactly this, and says why in a comment
(`packages/plugins/analytics/src/endpoints/websocket.ts`).

Rate limiting *does* apply to upgrades — it runs in `Bun.serve`'s fetch callback,
above everything (`packages/cli/src/worker.ts`).

## What middleware can see

`req.session` is a lazily-created `Session` bound by the worker
(`worker.ts`). Touching it creates a session; the cookie is emitted by
`processResponse` only if the session was modified or its cookie is past half
its `Max-Age`. See [Sessions](sessions.md).

`req.__hostname` is the resolved hostname, and `Bakery.config` inside a
middleware already reflects the per-host merge — the whole request runs inside
`hostStore.run(...)`, so config is ambient rather than passed.

For the client address, use `getClientIp`, which honours `config.trustProxy`
rather than trusting `X-Forwarded-For` blindly:

```ts
import { defineConfig } from '@bakery-framework/core'
import { getClientIp } from '@bakery-framework/core/utils/http'

export default defineConfig({
  trustProxy: true,
  middleware: [
    req => {
      const ip = getClientIp(req)
      if (BLOCKLIST.has(ip)) return new Response('Forbidden', { status: 403 })
    },
  ],
})

const BLOCKLIST = new Set<string>()
```

## Per-host middleware

A `hosts` entry replaces the middleware array wholesale for that hostname — it is
not concatenated with the global one (`packages/core/src/core/config.ts`):

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  middleware: [globalGuard],
  hosts: {
    'admin.example.com': {
      root: 'src/admin',
      middleware: [adminGuard], // globalGuard does NOT run here
    },
  },
})

function globalGuard(_req: Request): Response | void {}
function adminGuard(_req: Request): Response | void {}
```

The same replace-don't-merge rule applies to `onRequest`, `onError`, `proxy` and
`blocked`. `importMap` is the exception; it merges.

## The alternative that does run every time

Registering your own `Handler` does not help — it lives in the same registry and
is skipped by the same cache. The hook that runs unconditionally on every request
is a plugin's `onRequest`, called directly by `handleRequest`
(`packages/core/src/router.ts`, `core/plugins.ts`) with no caching in
between:

```ts
// src/plugins/admin-guard.ts
import { definePlugin, response } from '@bakery-framework/core'

export const adminGuard = definePlugin({
  name: 'admin-guard',

  onRequest(req) {
    const path = new URL(req.url).pathname
    if (!path.startsWith('/admin')) return
    if (req.headers.get('authorization')) return

    return response.error('Unauthorized', 401)
  },
})
```

```ts no-check — the import path is app-specific; the plugin itself is checked above
// server.config.ts
import { defineConfig } from '@bakery-framework/core'
import { adminGuard } from './src/plugins/admin-guard'

export default defineConfig({
  root: 'src',
  plugins: [adminGuard],
})
```

Two things to know about this hook:

- **Return `undefined` to continue.** Any other non-null return is coerced into a
  response — an object becomes a 200 JSON body, anything else becomes 200 text
  (`core/plugins.ts`). Returning `false` would end the request with the
  text `false`.
- **A throw is a 500** and stops the plugin chain, same fail-closed rule as
  middleware (`core/plugins.ts`).

Plugins run in `config.plugins` order, and all of them run before the `fetch`
registry is consulted at all.
