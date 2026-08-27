# Plugin API

A Bakery plugin is a plain object with optional lifecycle hooks. It is created
with `definePlugin` and listed in `server.config.ts`:

```ts
import { defineConfig, definePlugin, Logger } from '@bakery-framework/core'

const logger = new Logger('audit')

const audit = definePlugin({
  name: 'audit',
  onRoute(req) {
    logger.log(`${req.method} ${new URL(req.url).pathname}`)
  },
})

export default defineConfig({
  root: 'src',
  plugins: [audit],
})
```

`definePlugin` is an identity function. It exists only so TypeScript checks the
object against `ServerPlugin` and still infers the literal type — there is no
base class, no registration side effect, and no `PluginBase`. The value you get
back is the object you passed in
([`packages/core/src/plugins/types.ts`](../../packages/core/src/plugins/types.ts)).

Core never special-cases a plugin. Everything a plugin can do, an application
can do; the hooks below are the same ones the bundled Vue, analytics and
dashboard plugins use.

## The `ServerPlugin` interface

```ts no-check — the declaration verbatim; it is a type, not runnable code
export interface ServerPlugin {
  name: string
  setup?(config: ProcessedAppConfig): MixedPromise<void>
  tsconfig?: PluginTsConfig
  onStart?(server: Bun.Server<any>): MixedPromise<void>
  onRequest?(req: Request): ValidResponses
  onRoute?(req: Request): MixedPromise<void>
  onError?(error: Handler.Error.Data, req?: Request): ValidResponses
  onShutdown?(): MixedPromise<void>
  onCompile?(content: string, path: string): MixedPromise<string>
}
```

`tsconfig` is the odd one out: **declarative, and read by the tsconfig generator
at dev boot rather than by the running server.** Everything else in that
interface is a hook. See
[Contributing a tsconfig project](#contributing-a-tsconfig-project).

| Hook | Runs | Called from |
| --- | --- | --- |
| `setup` | at boot, after the core handlers are registered and before the route caches are warmed — once per process, see below | [`startup.ts`](../../packages/core/src/startup.ts) |
| `onStart` | once, after `Bun.serve` is listening and the banner has printed | [`startup.ts`](../../packages/core/src/startup.ts) |
| `onRoute` | every request, after the WebSocket upgrade check, before any handler | [`router.ts`](../../packages/core/src/router.ts) |
| `onRequest` | every request, immediately after `onRoute`; a returned value short-circuits the handler chain | [`router.ts`](../../packages/core/src/router.ts) |
| `onError` | on every error, before the error-handler registry | [`router.ts`](../../packages/core/src/router.ts) |
| `onCompile` | for every file the compiler transpiles, after import rewriting | [`compiler/compiler.ts`](../../packages/core/src/compiler/compiler.ts) |
| `onShutdown` | on SIGINT/SIGTERM, after the app's own shutdown hooks | [`cli/src/worker.ts`](../../packages/cli/src/worker.ts) |

Plugins run in the order they appear in `plugins: []`. There is no priority
scale for hooks — that scale exists for handlers, which is a separate thing
(see below).

### `setup` runs once per process

There are two call sites and both are needed. The boot script must run setup
before the import map is built, because a plugin may contribute entries to it;
and `setupServer()` must run it because a cluster worker is spawned straight
into `worker.ts` and passes through neither boot script. Both route through one
memoised `setupPlugins()` in `startup.ts`, so `setup()` itself runs exactly
once — and because the memo holds the promise rather than a flag, a concurrent
caller awaits the first run instead of racing it.

It used to run twice. That was harmless for handler and route-mount
registration — the registry is a `Map` keyed on the class, and `mountRoutes`
replaces a duplicate prefix — and not harmless for anything else: the analytics
plugin registered its shutdown hook and loaded its stored data twice. Side
effects in `setup` are safe now, but `onStart` is still the better home for
them.

### Failure behaviour

Every hook is invoked through `Try.catch`
([`core/plugins.ts`](../../packages/core/src/core/plugins.ts)). A throwing hook
is logged and the remaining plugins still run — one broken plugin does not take
the process down. The exception is `onRequest`: a throw there returns a 500 for
that request, because the plugin may have been an auth gate and continuing
would be failing open.

`onCompile` is a chain. Each plugin receives the previous plugin's output; a
plugin that returns a non-string is skipped and the content passes through
unchanged.

### What `onRequest` and `onError` may return

Both are typed `ValidResponses`, which is `Handler.Response`: a `Response`, a
`Bun.BunFile`, a string, any object, or nothing. `normalizePluginResult`
converts what you return
([`core/plugins.ts`](../../packages/core/src/core/plugins.ts)):

- `Response` — passed through, with head/body injection applied if it is HTML.
- an object — wrapped in the JSON envelope as `{time, status: 200, message: 'OK', data}`.
- anything else non-nullish — sent as `text/plain`.
- `null` / `undefined` — the next plugin runs, then the handler chain.

Returning nothing is the normal case. Return something only to intercept.

## Handlers are the real extension point

Hooks are for cross-cutting work. To *serve* something, register a `Handler`
subclass. This is convention 1 of the framework: no request-serving code lives
outside a registered handler.

```ts
import { Handler } from '@bakery-framework/core/handlers'
import { response } from '@bakery-framework/core/utils/http'

export class HealthHandler extends Handler {
  static canHandle(path: string) {
    return path === '/_health'
  }

  static handle() {
    return response.json.success('ok', { uptime: process.uptime() })
  }
}
```

`canHandle(path, req)` decides ownership and may be async; `handle(path, req)`
produces the response. Both are **static** — handlers are never instantiated
(`Handler`'s constructor is `protected`).

There are three independent registries — `Bakery.handlers.fetch`, `.error` and
`.websocket` — each with its own priority scale. Higher runs first. See
[Architecture](../reference/architecture.md) for the bands the core handlers
occupy; pick a number that puts you where you mean to be relative to them.

Register from `setup()`, not at module scope, so the registration happens after
config is loaded:

```ts
import { Bakery, definePlugin } from '@bakery-framework/core'
import { Handler } from '@bakery-framework/core/handlers'
import { response } from '@bakery-framework/core/utils/http'

class HealthHandler extends Handler {
  static canHandle(path: string) {
    return path === '/_health'
  }

  static handle() {
    return response.json.success('ok')
  }
}

export default function healthPlugin() {
  return definePlugin({
    name: 'health',
    setup() {
      Bakery.handlers.fetch.set(HealthHandler, 75)
    },
  })
}
```

## Declaring endpoints with `routeTable`

For a plugin serving a handful of exact paths, `routeTable` replaces the
hand-rolled `if (path === … && method === …)` chain
([`plugins/routes.ts`](../../packages/core/src/plugins/routes.ts)):

```ts
import { type PluginRouteTable, routeTable } from '@bakery-framework/core/plugins'
import { response } from '@bakery-framework/core/utils/http'

const routes = routeTable({
  '/api/_demo/status': () => response.json.success('ok'),
  'POST /api/_demo/reset': req => response.json.success('reset', req.method),
} satisfies PluginRouteTable)

export function dispatch(req: Request) {
  // Resolves to null when no key matches, so the handler can fall through.
  return routes(req)
}
```

Keys are either a bare path (matching any method) or a method-qualified path
(`'POST /api/_demo/reset'`); a method-qualified entry wins over a bare one for
the same path. Matching is exact — no params, no wildcards. Anything needing
those belongs in the core router's `DynamicHandler`, not in a second routing
implementation.

**Use `satisfies PluginRouteTable`, never a `:` annotation.** An annotation
erases the object's literal type before `routeTable` ever sees it, so the
generic collapses to the wide `PluginRoute` return type — which contains
`object`, which absorbs `Response`, `Bun.BunFile` and `JsonResponseData` into
one useless union member. `satisfies` checks the same constraint and keeps each
endpoint's real return type flowing through to the caller
([`plugins/routes.ts`](../../packages/core/src/plugins/routes.ts)). Both
bundled plugins that use it spell it out in a comment for exactly this reason.

Lookups use `Object.hasOwn`, so a path named `constructor` or `toString` cannot
reach an inherited `Object.prototype` member.

**The two key forms are guarded differently, and a match that fails the guard
answers `403` instead of running the handler.** A method-qualified key is an
author who thought about methods, so it gets the ordinary CSRF check: safe
methods through, unsafe ones same-origin. A bare key matches *every* method,
including the `GET` that a cross-site `<img src=…>` produces — which is how a
mutating endpoint registered under one ends up reachable from another site, and
`checkCsrf` is no help because it waves `GET` through by definition. A bare key
is therefore same-origin-only on every method.

The practical consequences:

- Registering a mutating endpoint under a bare key is no longer a silent CSRF
  hole. It still works for your own page; it stops working for everyone else's.
- If you *want* an endpoint reachable cross-origin, name the method:
  `'GET /api/_demo/status'`. That is the opt-out, and it is deliberate rather
  than accidental.
- A request that matches no key still resolves to `null`, not `403`, so an
  unmatched path falls through to the rest of the router as before.

A dispatch's return type therefore includes `Response` on top of whatever the
table's own endpoints return.

## Serving your own files: `mountRoutes`

Handlers resolve files under `Bakery.serveRoot`, which is the *application's*
directory. A plugin that ships its own assets would otherwise have to read,
bundle and cache them itself. `mountRoutes(prefix, dir)` maps a URL prefix onto
a directory outside the serve root, after which the normal pipeline — the TSX,
TS, HTML and static handlers, the compiler, the route cache, `getStatic`'s
containment checks — treats those files exactly like app files
([`handlers/core/$mounts.ts`](../../packages/core/src/handlers/core/$mounts.ts)):

```ts
import { mountRoutes } from '@bakery-framework/core/handlers'
import { fs } from '@bakery-framework/core/utils'

// Call this from the plugin's setup(). Anchor to *this* package, not to
// Bakery.root — the application's cwd is somewhere else entirely.
export function mountAssets() {
  mountRoutes('/_demo', fs.resolve(import.meta.dir, '../public'))
}
```

The mount directory becomes both the search root and the containment boundary,
so a mounted directory cannot be traversed out of. Prefixes match on segment
boundaries (`/_dash` will not capture `/_dashboard`), longest prefix first, and
re-registering a prefix replaces it rather than stacking.

One catch, and it is the dashboard's worked example: a handler you register at
a high priority intercepts paths *before* the mount is consulted. Keep
`canHandle` narrow, or your own assets will never reach the mount
([`plugins/dashboard/src/setup.ts`](../../packages/plugins/dashboard/src/setup.ts)).

## Contributing a tsconfig project

On every dev boot the framework writes a TypeScript project per concern into
`.cache/tsconfig/`
([packages/core/src/compiler/tsconfig-sync.ts](../../packages/core/src/compiler/tsconfig-sync.ts)).
Each project is standalone, made to be invoked directly against the one concern
it covers — `vue-tsc -p .cache/tsconfig/vue.json` for SFCs,
`tsc -p .cache/tsconfig/client.json` to hold browser code to browser rules.
Nothing wires them into the app's own `tsconfig.json`: they used to be added
as `references`, and because they are `noEmit` and never built, that made
`tsc -p .` fail in any app that had booted once (TS6305 for every file both
projects claim, TS6306/TS6310 for the reference shape itself). Core always
writes two:

| Project | Extends | Covers |
| --- | --- | --- |
| `server.json` | `core/tsconfig.server.json` | `<root>/**/api/**/*.ts`, `<root>/**/*.tsx`, `server.config.ts`, `orm/**` |
| `client.json` | `core/tsconfig.app.json` | `<root>/**/*.ts` except the api directory |

The split is the point: only `server` carries `bun-types`, so `Bun.hash()` in a
file bound for the browser is a **type error** rather than a runtime one.

A plugin that brings its own file type or its own ambient globals needs a project
to typecheck them under:

```ts no-check — an excerpt of @bakery-framework/plugin-vue's own definition
export default definePlugin({
  name: 'vue',
  tsconfig: {
    project: {
      name: 'vue',
      extends: '@bakery-framework/core/tsconfig.vue.json',
      include: ['src/**/*.vue'],
      // A package specifier, not a path: the plugin does not know where it was
      // installed, and the generator resolves it before writing.
      files: ['@bakery-framework/plugin-vue/vue.d.ts'],
    },
  },
})
```

| Field | Meaning |
| --- | --- |
| `name` | File name under `.cache/tsconfig/`, and the project's identity |
| `extends` | Usually one of core's three bases; written through as-is |
| `include` / `exclude` | Globs **relative to the app root** — the generator rewrites them |
| `files` | Ambient declarations the plugin owns. Package specifiers allowed |
| `compilerOptions` | Merged into the generated project |
| `importMapPaths` | Opt in to `paths` derived from `importMap`. Off by default |

Four things are easy to get wrong here, and each was:

- **`include` globs are app-relative, and the generator rewrites them.** The
  generated file sits two levels down, and `Bakery.config.root` is *absolute* —
  a first version emitted `../../C:/…/src/**`, a glob matching nothing. A project
  matching nothing typechecks clean, so it reported zero errors and looked
  perfect.
- **`files` takes package specifiers**, unlike TypeScript, which resolves `files`
  as paths and would call `@scope/pkg/x.d.ts` a missing file. Resolution failure
  is logged and skipped, never fatal — a plugin whose declarations cannot be found
  should degrade to "no types", not stop the dev server.
- **`importMapPaths` is off by default**, because an import map is resolved *by
  the browser*. The generator used to write those aliases into every project, so
  a server file could import an alias only the browser can satisfy and typecheck
  clean doing it. Set it only if your project compiles browser code.
- **A name collision is skipped, with a log.** A plugin cannot replace `server`,
  `client`, or another plugin's project — silently winning would present as "my
  types stopped working" three plugins later.

The app's root config is not the generator's to write: it is created only when
missing (Bun's runtime reads the JSX options from it), and the one edit made to
an existing one is removing the `references` a previous release wrote. Every
key you wrote survives. That restraint is scar tissue twice over — see
[Troubleshooting](../reference/troubleshooting.md#tsconfigjson-keeps-getting-rewritten)
for both incidents.

## Reserved namespaces

- `/_*` and `/api/_*` — framework and plugin routes. Application routes should
  not start with an underscore segment; the analytics collector also treats any
  path beginning `/_` as an asset and excludes it from page-hit counts.
- `__bakery.` — session-key prefix for framework privilege markers. Any code
  that writes a caller-supplied session key must refuse this prefix, or a
  preferences endpoint becomes a privilege-escalation primitive. Use
  `isReservedSessionKey` from `@bakery-framework/core/session`.

The paths already taken — by core and by each bundled plugin — are listed in
[Routing → Reserved paths](../guides/routing.md#reserved-paths). Check it before
choosing a namespace for your own plugin; it is the single canonical copy.

## Conventions a plugin is expected to follow

Items 2, 3 and 5 are enforced across the repo by
[`tests/conventions.test.ts`](../../tests/conventions.test.ts) — a plugin in
this workspace that breaks one fails the suite. Items 1 and 4 are review rules;
nothing checks them automatically.

1. **Guards return `Response | null` and fail closed.** A guard returns the
   rejection — the caller does `if (denied) return denied` — rather than
   throwing for an expected denial, and returns the rejection, not `null`, on
   any indeterminate state. An authorization check that throws is
   indeterminate, so it denies.
2. **One JSON envelope.** Every JSON body goes out as
   `{time, status, message, data}` via `response.json.*`. Return the
   `JsonResponseData` object; the router serialises it and stamps `time` in
   `processResponse`.
3. **No `console.*`.** Use a `Logger` instance or a declared message table.
4. **No unbounded caches.** Module-level caches are `LRUCache`, or provably
   bounded by config. Never key a map on a client-supplied header.
5. **`Try` / `Try.catch` is the error idiom.** A bare `catch {}` needs a
   comment saying why silence is correct.

## Related pages

- [Vue](vue.md) — a plugin that adds a file type, using `setup` and `onCompile`.
- [Analytics](analytics.md) — `onRoute`, `onError`, `onStart`, a WebSocket
  handler and a `routeTable`.
- [Dashboard](dashboard.md) — a `routeTable`, a route mount, and an
  application-supplied authorization predicate.
- [Database Explorer](db-explorer.md) — a `routeTable` whose key spellings
  *are* its CSRF policy, and an authorize predicate that grants a level rather
  than a boolean.
- [Architecture](../reference/architecture.md) — the registries and priorities.
