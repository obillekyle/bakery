# Project structure

Bakery has no `src/pages`, no `app/` convention and no generated routes file.
The directory layout *is* the routing table: a request path is resolved against
the filesystem at request time, and the result is cached.

This page describes an application's layout. For the framework repo's own
layout, see [the last section](#the-framework-repo).

## An application

```
apps/notes/
  package.json          scripts + the three @bakery/* dependencies
  server.config.ts      optional; `root` is the only option most apps set
  tsconfig.json         extends @bakery/core/tsconfig.app.json
  orm/
    schema.ts           tables — the generator owns this file
    index.ts            re-exports + the schema type registration
    indexes.ts          index() / unique() declarations
  src/                  ← the serve root. Everything here is web-reachable.
    index.tsx           /
    about.html          /about
    notes/[id].tsx      /notes/123
    error-404.html      any 404 under src/
    api/
      notes.ts          /api/notes
    styles/app.css      /styles/app.css
    script.ts           /script.js  (and /script.ts)
  public/               ← served at /uploads/, NOT under the serve root
  .data/                generated: database, backups, cache store
  .bakery/cache/        generated: compiled and assembled output
```

Only `package.json` is strictly required. With no `server.config.ts` at all the
app still boots on the defaults.

## The roots, and where they come from

Every path the framework uses is derived from two things: the process's current
working directory, and `root` in `server.config.ts`. All of it lives on the
`Bakery` service locator
([packages/core/src/core/bakery.ts](../../packages/core/src/core/bakery.ts)).

| Name | Value | Meaning |
| --- | --- | --- |
| `Bakery.root` | `process.cwd()` | the app directory — **run the CLI from here** |
| `Bakery.serveRoot` | `config.root`, default `src` | the only directory routes are resolved in |
| `Bakery.apiRoot` | `<serveRoot>/api` | JSON endpoints |
| `Bakery.publicRoot` | `<cwd>/public` | served at `/uploads/`, outside the serve root |
| `Bakery.cacheDir` | `<cwd>/.bakery/cache` | disposable |
| `Bakery.dataDir` | `<cwd>/.data` | **not** disposable |

Two of these routinely surprise people.

**`publicRoot` hangs off the cwd, not the serve root.** With `root: 'src'`, the
public directory is `./public`, a *sibling* of `src/`, and it is only reachable
under the `/uploads/` prefix
([packages/core/src/handlers/assets/public.ts](../../packages/core/src/handlers/assets/public.ts)).
`src/public/` would be served as ordinary static files at `/public/...`, which
is a different thing entirely.

**`.data` is deliberately not under `.bakery`.** The comment in the source says
why: cache is disposable and the database is not, and a single shared parent
would mean "clear the cache" could destroy data.

Because everything resolves against `process.cwd()`, running the CLI from the
repo root instead of the app directory silently gives you a different app. The
root `package.json` scripts `cd apps/example` for exactly this reason.

## How a path becomes a file

The serve root is scanned per request, then cached in an LRU keyed by hostname
and path. Resolution runs in three stages
([packages/core/src/handlers/core/$dynamic.ts](../../packages/core/src/handlers/core/$dynamic.ts),
[packages/core/src/handlers/core/$routing.ts](../../packages/core/src/handlers/core/$routing.ts)):

1. **Exact file.** `/about` looks for `about.<ext>` in the serve root.
2. **Directory index.** Failing that, `about/index.<ext>`.
3. **Dynamic segment.** Failing that, a `[param].<ext>` file at that level.

Static always beats dynamic, at every level. `src/blog/existing.tsx` wins over
`src/blog/[id].tsx` for `/blog/existing` — you do not have to order anything.

The extension a stage looks for depends on which handler is asking, and handlers
are tried in priority order:

| Priority | Handler | Serves |
| --- | --- | --- |
| 70 | `ApiHandler` | `.ts` / `.js` under `<root>/api`, for `/api/*` |
| 60 | `TSXHandler` | `.tsx` pages |
| 55 | `HTMLHandler` | `.html` pages |
| 50 | `TSHandler` | `.ts` compiled to browser JS |
| 0 | `StaticHandler` | any other file, verbatim |

So a `.tsx` and an `.html` at the same route name both resolve, and the `.tsx`
wins. The full table, including the asset and middleware bands, is in
[Architecture](../reference/architecture.md).

Extensionless URLs are the norm — `/about` serves `about.html` — but an explicit
extension works too. `TSHandler` additionally strips a trailing `.js`, so
`src/script.ts` is reachable at both `/script.ts` and `/script.js`
([packages/core/src/handlers/assets/ts.ts](../../packages/core/src/handlers/assets/ts.ts)).

Details of dynamic segments, mounts and proxying live in
[Routing](../guides/routing.md).

## Error pages

`error.html`, `error.tsx`, `error-404.html`, `error-500.tsx` — the name encodes
the scope. Lookup walks *up* from the requested path, and at each level tries
`error-<code>` before the generic `error`
([packages/core/src/handlers/core/$error.ts](../../packages/core/src/handlers/core/$error.ts)).

For a 404 at `/blog/2024/x`, the order is:

```
src/blog/2024/error-404 → src/blog/2024/error
src/blog/error-404      → src/blog/error
src/error-404           → src/error
```

Then the framework's built-in page. Errors under `/api/` never reach any of
this — `ApiErrorHandler` returns the JSON envelope with the right status code.

Custom HTML and TSX error pages are served with the real error status:
`applyErrorStatus` stamps the error's code (400–599) onto the rendered response
([packages/core/src/router.ts](../../packages/core/src/router.ts)), so an
`error-404.html` answers with a 404, not a 200.

## Reserved URL prefixes

These are claimed by the framework and its plugins. A file of yours at the same
path is unreachable
([packages/core/src/startup.ts](../../packages/core/src/startup.ts)):

| Prefix | Serves | Registered by |
| --- | --- | --- |
| `/api/*` | `<serveRoot>/api` | core |
| `/uploads/*` | `<cwd>/public` | core |
| `/_nm/*` | `<cwd>/node_modules`, bundled on demand | core |
| `/_client/*`, `/_virtual/*` | framework browser runtime | core |
| `/_gf/*` | Google Fonts, proxied and cached to disk | core |
| `/_dashboard`, `/api/_dashboard/*` | admin console | `@bakery/plugin-dashboard` |
| `/_analytics/*`, `/_analytics_ws` | telemetry | `@bakery/plugin-analytics` |
| `/_vue/*` | compiled SFC chunks | `@bakery/plugin-vue` |

The convention is that `/_*` and `/api/_*` belong to the framework, and
`__bakery.` prefixes framework session keys. Plugins are expected to stay inside
it.

## Files that are never served

Even inside the serve root, a set of globs is refused whenever a file-serving
handler would answer
([packages/core/src/utils/constants.ts](../../packages/core/src/utils/constants.ts)):

```
.env  *.env  *.sql  *.db  *.yaml  *.yml  *.lock  bun.lockb  *.exe
package.json  package-lock.json  tsconfig.json  tsconfig.*.json
.bakery/  .data/  _internal/  .git/  .vscode/  node_modules/
server.config.ts  schema.ts  .gitignore
```

`blocked` in `server.config.ts` appends to that list; it cannot shorten it.

The check is on the **request path**, applied after routing and only to the
handlers that serve files off disk — middleware, the proxy and the API handler
are exempt, because for them a path is a route name, not a file
([packages/core/src/router.ts](../../packages/core/src/router.ts)). So
`/api/manifest.json` routes normally, while `/package.json` is a 403 from every
file-serving handler. Case and Win32 trailing-dot variants are folded before
matching, so `/PACKAGE.JSON` is refused too. There is deliberately no blanket
`*.json` ban — a `manifest.json` or `.well-known` document under `src/` is
servable; only the named project files are protected.

Traversal is checked separately: a resolved path must sit inside the root it was
resolved against, and `fs.isForbidden` additionally refuses any directory
containing a `.forbidden` marker file
([packages/core/src/utils/fs.ts](../../packages/core/src/utils/fs.ts)).

## Where the schema lives

The ORM probes the app's cwd, in order
([packages/orm/src/sync/load.ts](../../packages/orm/src/sync/load.ts)):

1. `schema` in `server.config.ts`, if set — a file or a folder.
2. `orm/index.ts` — the folder layout.
3. `schema.ts` — the single-file layout.

Absence is fine: everything runs and typechecks with no schema at all, and the
ORM is simply untyped. But a **configured** path that does not exist is a hard
error that exits 1, deliberately — a silent fallback on a typo would have the
generator write a fresh schema at the wrong path while your real model sat
untouched somewhere else.

Prefer the folder layout for anything non-trivial. `db:sync --choose=db`
regenerates `schema.ts` from the database; in the folder layout it writes only
`orm/schema.ts` and never touches `orm/index.ts` or `orm/indexes.ts`, so
hand-written declarations survive.

## Generated directories

Both are gitignored and neither should be committed.

**`.bakery/cache/`** — safe to delete at any time:

| Subdirectory | Contents |
| --- | --- |
| `ts_cache/` | `.ts` compiled to browser JS |
| `html/` | HTML with the framework's head/body injections already applied |
| `static/` | pre-compressed static assets (`.gz`, `.zst`) |
| `nm_cache/` | bundled node modules served under `/_nm/` |
| `gf_cache/` | fetched Google Fonts CSS and font binaries |
| `virtual/` | the compiled client runtime |
| `server.json` | the mode and framework version the cache was built for |

That last file is the invalidation key: on boot, if either value differs from
the current process, the whole cache directory is deleted and recreated
([packages/core/src/core/config.ts](../../packages/core/src/core/config.ts)).

**`.data/`** — not disposable:

| Path | Contents |
| --- | --- |
| `server.db` | the SQLite database, when no `DB_URL` is set |
| `shared-cache.db` | the tiered cache's persistent tier |
| `backups/` | database and schema copies taken before a destructive sync |

## The framework repo

```
packages/
  core/src/            @bakery/core — no runtime dependencies
    startup.ts         registry population + the startup banner
    router.ts          handleRequest / handleRequestError / processResponse
    handlers/          every request surface, as a Handler subclass
    core/              bakery.ts, config.ts, plugins.ts, jsx.ts, init.ts
    utils/isomorphic/  pure; compiled into the browser bundle as-is
    utils/             server-side helpers (http/, fs, common/)
    client/            the browser runtime
    cache/  logger/  compiler/  plugins/
  orm/src/             @bakery/orm — adapters/, orm/, sync/, backup
  cli/src/             @bakery/cli — the `bakery` bin and mode dispatch
  plugins/{vue,analytics,dashboard}/
apps/
  example/             the bundled demo and end-to-end target
  starter/             a minimal second consumer, public entry points only
```

Directories nest but package names stay flat: `packages/plugins/vue` publishes
as `@bakery/plugin-vue`.

The aliases `@server/*`, `@database/*` and `@plugins/*` appear in some
package-internal tsconfigs but are **not available to applications**. Import
from `@bakery/core`, `@bakery/orm` and `@bakery/plugin-*`.

## Next

- [Routing](../guides/routing.md) — dynamic segments and priority in full.
- [server.config.ts](../configuration/server-config.md) — every option.
- [Architecture](../reference/architecture.md) — the request pipeline.
