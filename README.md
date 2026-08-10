# Bakery

A batteries-included server framework for [Bun](https://bun.sh): filesystem
routing, server-rendered JSX, cookie sessions, a typed ORM with schema sync, a
plugin system, and a live-reload dev loop — with no build step in development.

Bakery serves files the way Apache served directories: drop a `.tsx`, `.html`,
`.ts`, or `/api` file under your app's `src/` and it is a route on the next
request. Routes are resolved against the filesystem per request — a dropped-in
file serves, a deleted one stops — and in development route modules are
re-imported when their mtime changes, so there is no route table to register
and, for most edits, no restart.

## Quick start

```bash
bun create bakery my-app
cd my-app
bun run db:sync
bun run dev
```

That scaffolds an app, creates its SQLite database and serves it on port 3000.
The scaffolder asks what to include — the ORM, and any of the three plugins —
and every answer is also a flag (`--no-orm`, `--plugins vue,dashboard`, `--yes`),
so it drives from a Dockerfile as well as from a terminal.

Requires Bun 1.3.14 or newer, which every package declares as its floor.
TypeScript is only needed for typechecking — Bun transpiles everything at
runtime — and a generated app installs it for you.

[Installation](docs/getting-started/installation.md) covers the flags, adding
Bakery to an existing project, and working on the framework itself;
[Your first app](docs/getting-started/first-app.md) walks through every file.

## What's in the box

- **Filesystem routing** — a URL resolves to a file under `root` (default
  `src/`): `.tsx` pages rendered to HTML on the server through Bakery's own
  JSX runtime, with a same-stem sibling `.ts`/`.css` auto-injected as script
  and stylesheet (`about.tsx` picks up `about.ts` and `about.css` — the stem is
  the page's own filename, not a reserved name); `.html` pages with
  `{{param}}` substitution; `.ts` files
  compiled for the browser on request; `/api/*` JSON handlers; `[param]`
  dynamic segments; and static files with ETag/conditional-GET handling.
- **Typed routes** — `defineRoute<P>` types the body an `/api` handler
  receives, `HTMLBody<P>` (also exported as `html`) does the same for a `.tsx`
  page's render function. Both are identity functions — inference only — and
  the `RouteBody`/`RouteResponse` types behind them are exported from
  `@bakery-framework/core`.
- **Sessions** — a lazily-created cookie session on every request, backed by a
  tiered memory-then-SQLite cache.
- **ORM** (`@bakery-framework/orm`) — schema declared in TypeScript, a query builder and
  mutations typed from it, SQLite by default with MySQL/Postgres via `DB_URL`,
  and a sync engine that diffs schema against database, prompts before
  destructive changes, and takes a backup first.
- **Plugins** — register handlers, route mounts, and lifecycle hooks. Bundled:
  Vue single-file-component routes, request analytics, and an admin dashboard.
- **Security defaults** — blocked-file globs (`.env`, lockfiles, configs, the
  schema), a same-origin CSRF guard on unsafe `/api` methods, and an
  on-by-default per-IP rate limit.
- **Also in core** — WebSockets, reverse proxy, per-hostname (multi-host)
  config, image resizing via `;<size>` URL suffixes, a Google Fonts
  proxy/cache, and middleware/`onRequest`/`onError` hooks.

An `/api` route, complete — save it as `src/api/posts.ts` and `POST /api/posts`
exists:

```ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute<{ title?: string }>(async (req, body) => {
  if (req.method !== 'POST') {
    return response.json.error(405, 'Method Not Allowed')
  }

  const title = String(body.title ?? '').trim()
  if (!title) return response.json.error(400, 'title is required')

  return response.json.success('created', { title })
})
```

`body.title` is `string | undefined` inside the handler. Declaring the shape
states your contract — it does not validate the request, so validate anyway.

## Workspace layout

| Package | Contents |
| --- | --- |
| `@bakery-framework/core` | handlers, router, config, sessions, caches, logger, compiler, JSX |
| `@bakery-framework/orm` | query builder, mutations, adapters, schema sync, backup |
| `@bakery-framework/cli` | the `bakery` binary: dev supervisor, production, cluster dispatch |
| `@bakery-framework/plugin-vue` | `.vue` single-file components with server blocks |
| `@bakery-framework/plugin-analytics` | request telemetry |
| `@bakery-framework/plugin-dashboard` | the admin console |
| `apps/example` | the bundled demo app |
| `apps/starter` | a minimal app written against public entry points only |

`@bakery-framework/core` has no runtime dependencies; the ORM depends only on
core; the CLI depends on core and takes the ORM as an **optional peer**, so an
app scaffolded without a database does not install one.

## How a request is served

Three priority-ordered handler registries (fetch, error, websocket) are
populated in [`packages/core/src/startup.ts`](packages/core/src/startup.ts);
a request walks the fetch registry from middleware (priority 100) through
proxy, virtual assets, images, `/api`, `.tsx`/`.html`/`.ts` routes, down to the
static-file fallback (0), and the first handler whose `canHandle` claims the
path wins — with resolutions cached in a shared LRU and re-validated on every
hit. Because resolution is against the filesystem, dropping in or deleting a
file is honored on the next request in any mode; in development, route modules
are additionally imported with mtime cache-busting, so editing one is live too
(in production a route module is imported once). The full walk-through is in
[docs/reference/architecture.md](docs/reference/architecture.md).

## The dev loop

`bakery --dev` runs a supervisor that spawns the serving worker and watches
files. Editing the `.tsx` page or `/api` route you are working on takes effect
immediately (mtime-busted re-import); `.css` changes hot-swap the stylesheet in
the browser; other source changes clear route caches and reload the page. Only
three things restart the worker: a change to `server.config.ts`, a change
anywhere under the api directory, and *creating* a `.tsx`/`.jsx` file — Bun
caches the directory listing it resolved against, so a page that did not exist
at boot cannot be imported at any specifier until the process restarts. Editing
an existing page does not restart. Server-pushed errors
appear in the browser as a dismissable overlay, and a dead dev server shows a
"disconnected" overlay that reloads when it returns. Schema sync runs before
each boot, but only actually executes when a content hash of the schema sources
(recorded under `.cache/`) has changed — so restarts stay fast.

One honest limitation: only the route file's own mtime is checked. Editing a
shared helper or component that a page imports needs a dev-server restart.

## Configuration

`server.config.ts` is optional — the defaults (`root: 'src'`, port 3000, host
`0.0.0.0`, SQLite at `bakery/server.db`) are a working config. `defineConfig`
is an identity function that typechecks the object against `AppConfig`:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3000,
  rateLimit: false,
})
```

The rate limit is worth knowing about: an unconfigured app gets
`{ max: 100, refill: 10 }` — a 100-request burst refilling at 10 requests per
second, per client IP. The startup banner announces it, and `rateLimit: false`
disables it. The full option surface is documented in
[docs/configuration/server-config.md](docs/configuration/server-config.md).

## Deployment

`bunx bakery` with no flags is production mode: no watcher, no live reload, no
implicit schema sync (pass `--sync`/`-s` to run one at startup). The port comes
from `PORT` in the environment, then `port` in the config — there is no port
flag. `--threads N` (`-t N`) forks a cluster of workers sharing one port via
`SO_REUSEPORT`, which only Linux provides — on any other platform the count is
clamped to 1 with a warning. Set `NODE_ENV=production` on production hosts; it
is what arms the sync engine's destructive-change guard.

The flag list is exactly `--dev`, `--sync`/`-s`, `--threads`/`-t`, and the
internal worker markers. There is no `--help`, and unknown flags are silently
ignored — `bakery --port 8080` starts a production server. See
[docs/reference/cli.md](docs/reference/cli.md).

## Documentation

**[bakery.okyle.dev](https://bakery.okyle.dev)** — installation through to the
architecture reference.

The source is [`docs/`](docs/README.md) in this repository, and the site is
built from it, so the two cannot drift. Every TypeScript example is compiled
against the real packages by `tests/docs-examples.test.ts`, which means an
example that stops working fails CI rather than the reader.

## License

MIT with the Commons Clause v1.0 condition — see [LICENSE](LICENSE).

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
