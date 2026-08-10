# Middleware

Middleware in Bakery is a `Handler` like everything else. `MiddlewareHandler`
sits at priority 100 in the `fetch` registry — the top — and runs the functions
you declared in config (`packages/core/src/startup.ts`).

It runs on **every** request, including ones an earlier request to the same path
was allowed through — see [the route cache](#the-route-cache-does-not-skip-middleware).

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

- `config.onRequest(req)` runs first, before the array. Any truthy return stops
  the request; HTML gets injected, anything else is passed through as-is.
- `config.middleware` is an array of
  `(req, server) => Response | JsonResponseData | void`, run in declaration
  order.

If nothing stops the chain, `canHandle` reports false and the request continues
down the registry to the page, API or asset handler that owns it.

Returned responses go through HTML injection, so a middleware that returns a full
HTML document still gets the import map, live-reload script and configured
`head`/`body` fragments.

### What stops the chain

Exactly two shapes, and the second is the `response.json.*` envelope every other
part of the framework speaks:

```ts
import { defineConfig, response } from '@bakery-framework/core'

export default defineConfig({
  middleware: [
    req => {
      const path = new URL(req.url).pathname
      if (!path.startsWith('/admin')) return // continue

      // Both of these stop the request.
      if (req.headers.get('accept')?.includes('application/json')) {
        return response.json.error(401, 'Sign in required')
      }
      return new Response('Unauthorized', { status: 401 })
    },
  ],
})
```

| middleware returns | result |
| --- | --- |
| `new Response(…)` | stops the chain, status preserved |
| `response.json.error(401, …)` | stops the chain, `401` + the `{time, status, message, data}` envelope |
| `response.json.success(…)` | stops the chain, same envelope |
| a string, a bare object, `true` | **ignored** — the next middleware runs |
| `undefined` / no return | continue |

The ignored row is deliberate. Returning a value is how plenty of ordinary code
signals nothing at all — an implicit arrow return, an assignment expression, a
`.map` callback — so only the two shapes that unambiguously mean "I am the
response" halt the request.

The envelope used to be in that ignored row, which made an auth guard written
the documented way fail **open**: the value was not a `Response`, the chain
carried on, and the protected page was served with a `200`. On a path with no
route it surfaced instead as a puzzling `404` — the framework's own error page,
with the `401` and the message gone. Pinned by `$middleware.test.ts`.

### A `Response` with a 4xx/5xx status gets the error page

Worth knowing before you debug it. Any `Response` with `status >= 400` — from
middleware or anywhere else — is routed through `handleRequestError`
(`packages/cli/src/worker.ts`), which **keeps the status and replaces the
body** with the app's error page, or the framework's built-in one:

```
new Response('Unauthorized', { status: 401 })
  →  401, but the body is the Bakery 401 error page, not "Unauthorized"
```

A `response.json.*` envelope does not go through that path — `handleRequestError`
keys on `errorCode`, which an envelope does not carry — so it reaches the client
exactly as written. If you want your own message on the wire, that is the reason
to prefer the envelope.

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

## The route cache does not skip middleware

`HandlerMap.resolve` (`packages/core/src/handlers/core/$registry.ts`)
remembers which handler won for a `(registry, hostname, path)` key, and on a
later request it asks only that handler whether it still applies. Middleware is
exempt: `MiddlewareHandler` sets `alwaysResolve = true`, and the registry
consults every `alwaysResolve` handler before it looks at the cache
(`$registry.ts`, pinned by `$registry.test.ts`).

That exemption is load-bearing, because without it the cache would defeat a
guard in the one direction that matters. `MiddlewareHandler` is only cacheable
when it actually produces a response, so a guard that rejects would stay cached
and keep working — and the *first request it let through* would install the page
handler in its place, after which nobody was checked again. A guard that tests
green, works in staging, and stops the moment one legitimate user signs in.

Measured on a running server, with a counter in the middleware: three requests
to a denied path and three to an allowed one increment it six times.

Two things the exemption does not buy you:

- Middleware that wants to run **once** per path — priming a cache, logging a
  first hit — has to track that itself.
- It costs a `canHandle` per request, which for middleware means running the
  whole chain. Keep the chain cheap; it is on every request including static
  assets.

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

## The other hook that runs every time

A plugin's `onRequest` is called directly by `handleRequest`
(`packages/core/src/router.ts`, `core/plugins.ts`), before the `fetch`
registry is consulted at all. Reach for it when the guard belongs to a
redistributable plugin rather than to one app's config; for an app's own auth
check, `config.middleware` is the simpler place and runs just as unconditionally.

Note that a plain `Handler` of your own is **not** an alternative — it lives in
the same registry as everything else and is subject to the route cache, which
`MiddlewareHandler` is exempt from and yours would not be unless you set
`alwaysResolve` yourself.

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
