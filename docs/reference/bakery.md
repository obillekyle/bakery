# The `Bakery` object

```ts
import { Bakery } from '@bakery-framework/core'
```

One object, available everywhere, holding the paths the framework resolved, the
config for the current request, the three handler registries, and the shutdown
hook list. It is also the default export of `@bakery-framework/core`.

**`Bakery` is a global *type*, not a global *value*.** `interface Bakery` is
declared ambiently, so `let x: Bakery` needs no import
([packages/core/src/global.d.ts](../../packages/core/src/global.d.ts)) — but the
object itself is not bound on `globalThis`, and only `createElement`, `Fragment`
and `html` are. A route that uses the bare identifier gets `undefined` at
runtime, with nothing failing at typecheck to warn you. Import it.

It is a **service locator, not a server instance**. There is no `new Bakery()`,
nothing to configure on it, and no second one. The single mutable thing on it is
the shutdown hook list.

## Paths

Every path the framework uses derives from two inputs: the process's working
directory, and `root` in `server.config.ts`
([packages/core/src/core/bakery.ts](../../packages/core/src/core/bakery.ts)).

| Property | Value | Meaning |
| --- | --- | --- |
| `Bakery.root` | `process.cwd()` | the app directory — **run the CLI from here** |
| `Bakery.serveRoot` | `config.root`, default `src` | the only directory routes resolve in |
| `Bakery.apiRoot` | `<serveRoot>/api` | JSON endpoints |
| `Bakery.publicRoot` | `<root>/public` | served at `/uploads/`, outside the serve root |
| `Bakery.cacheDir` | `<root>/.cache` | disposable; the framework empties it itself |
| `Bakery.dataDir` | `<root>/bakery` | **not** disposable — database, sessions, backups |

Three of those are **getters, not fields**, and the difference matters:
`serveRoot`, `apiRoot` and `publicRoot` read `Bakery.config` on every access, so
under multi-host they answer for *the host being served right now*. `root`,
`cacheDir` and `dataDir` are fixed at process start.

`publicRoot` hangs off `root`, not `serveRoot`. With `root: 'src'` the public
directory is `./public`, a *sibling* of `src/`. `src/public/` would be served as
ordinary static files at `/public/...`, which is a different thing entirely.

These two paths have exactly one writer each, here. Anything else that computed
its own copy has been removed — a second copy of the cache path once got handed
to a recursive delete.

## `Bakery.config`

```ts
import { Bakery } from '@bakery-framework/core'

export const serveRoot = () => Bakery.config.root
```

A **getter** that returns the current host's config, falling back to the process
config when no host scope is active. Per-request configuration is therefore
*ambient* rather than passed: a handler reading `Bakery.config.root` gets the
right answer without anyone threading a config object through the call.

The mechanism is an `AsyncLocalStorage` (`hostStore`) that `worker.ts` enters
before routing. The consequence to know: outside a request — module scope, a
`setInterval`, a shutdown hook — there is no host scope, so you get the process
config. That is correct, and it is also why a cached value computed at module
scope can be wrong under multi-host. See
[Multi-host](../configuration/multi-host.md).

The object is frozen. `getConfig()` is the same value without the host lookup.

## `Bakery.handlers`

The three registries every request surface registers into. Higher priority runs
first, and **each scale is independent** — a fetch handler at 90 and an error
handler at 20 are not comparable.

```ts no-check — `MyHandler` stands in for the reader's own Handler subclass
Bakery.handlers.fetch.set(MyHandler, 75)
```

| Registry | Serves |
| --- | --- |
| `Bakery.handlers.fetch` | ordinary requests |
| `Bakery.handlers.error` | thrown errors and status ≥ 400 |
| `Bakery.handlers.websocket` | upgrade handshakes |

The populated tables are in [Architecture](architecture.md). Plugins register
here through `setup()`; see [the plugin API](../plugins/plugin-api.md).

## `Bakery.onShutdown`

```ts no-check — illustrative; the subscription stands in for the reader's own
Bakery.onShutdown(async () => {
  await flushSomething()
})
```

Hooks run on `SIGINT` and `SIGTERM`. This is where the session store flushes its
dirty entries, so anything you register alongside it is subject to the same
budget: a hook that blocks holds up the process exit.

`onShutdown` in `server.config.ts` is a separate, single hook — this is the list
form, and the one a plugin uses.

## The rest

| Property | What it is |
| --- | --- |
| `Bakery.version` | the **app's** version, read from `<cwd>/package.json` |
| `Bakery.startNs` | `Bun.nanoseconds()` at process start; the epoch for request timings |
| `Bakery.sharedPool` | a 1 MB `SharedArrayBuffer` pool — the rate-limit token buckets and the request/error counters live in it |
| `Bakery.server` | the `Bun.serve` return value, **unset until the server has started** |
| `Bakery.shutdownHooks` | the array behind `onShutdown` |

**`Bakery.version` is the application's version, not the framework's**, and the
name has misled people. `import.meta.env.BAKERY_VERSION`, the define available
in browser code, is the same value under a worse name — the compiler reads it
from `<cwd>/package.json`, which is the app being served
([packages/core/src/compiler/compiler.ts](../../packages/core/src/compiler/compiler.ts)).
For the framework's own version, use `getFrameworkVersion()` from
[`core/context`](../../packages/core/src/core/context.ts). Both invalidate the
compiled cache; only one of them moves when you upgrade Bakery.

`Bakery.sharedPool` is bound to the master's buffer in a cluster, so the
rate-limit budget you configure is the budget **across all workers**, not per
worker.

**`Bakery.server` is undefined during boot.** Anything reading it at module
scope, in a plugin `setup()`, or in `onStart` before `Bun.serve` returns gets
`undefined`. Route handlers receive it as their third argument for exactly this
reason, and `RouteHandler` declares that parameter optional to match.

## Multi-host helpers

Exported alongside `Bakery` because they are the pieces of it that are useful on
their own:

| Export | Purpose |
| --- | --- |
| `getHostname(req)` | `X-Forwarded-Host` when `trustProxy` is set, else `Host`, else the URL |
| `hostKey(path)` | namespace a cache key by the current host |
| `hostStore` | the `AsyncLocalStorage` `Bakery.config` reads |

**`hostKey` collapses an unconfigured hostname to the bare key**, and that is a
security property rather than an optimisation. The key becomes a *filename* in
five handlers, so prefixing the raw `Host` header let any client mint unbounded
cache entries — 25 requests for one path under 25 invented hostnames took the
cache directory from 9 files to 84. Collapsing is safe because an unconfigured
host is served the base config, so its content is identical to the default
bucket's.

Use `hostKey` for anything you cache per tenant. See
[Multi-host](../configuration/multi-host.md).

## What is *not* on it

- **No `Bakery.db`.** The ORM is a separate, optional package; import `DB` from
  `@bakery-framework/orm`.
- **No `Bakery.logger`.** Logging goes through declared message tables — see
  [the plugin API](../plugins/plugin-api.md#logging).
- **No request or response.** Those are arguments. The only ambient
  request-scoped thing is the host config, and that is deliberate.

## Next

- [Architecture](architecture.md) — the request pipeline and the full registry tables.
- [Multi-host](../configuration/multi-host.md) — what `hostStore` is for.
- [server.config.ts](../configuration/server-config.md) — everything `Bakery.config` can hold.
</content>
