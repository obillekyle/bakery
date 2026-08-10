# Project structure

Bakery has no `src/pages`, no `app/` convention and no generated routes file.
The directory layout *is* the routing table: a request path is resolved against
the filesystem at request time, and the result is cached.

This page describes an application's layout. For the framework repo's own
layout, see [the last section](#the-framework-repo).

## An application

```
notes/
  package.json          scripts + the @bakery-framework/* dependencies
  server.config.ts      optional; `root` is the only option most apps set
  tsconfig.json         extends @bakery-framework/core/tsconfig.server.json
  orm/
    tables.ts           table() declarations — the generator owns this file
    views.ts            view() declarations
    indexes.ts          Field.Index() / Field.Unique() declarations
    index.ts            re-exports the three + the schema type registration
  scripts/db-sync.ts    what `bun run db:sync` runs
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
  bakery/               generated: database, sessions, backups (must persist)
  .cache/               generated: compiled and assembled output (disposable)
```

This is what `bun create bakery` writes, minus the routes added to illustrate
resolution. Only `package.json` is strictly required — with no
`server.config.ts` at all the app still boots on the defaults.

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
| `Bakery.cacheDir` | `<cwd>/.cache` | disposable |
| `Bakery.dataDir` | `<cwd>/bakery` | **not** disposable |

Two of these routinely surprise people.

**`publicRoot` hangs off the cwd, not the serve root.** With `root: 'src'`, the
public directory is `./public`, a *sibling* of `src/`, and it is only reachable
under the `/uploads/` prefix
([packages/core/src/handlers/assets/public.ts](../../packages/core/src/handlers/assets/public.ts)).
`src/public/` would be served as ordinary static files at `/public/...`, which
is a different thing entirely.

**The precious directory is the visible one.** The framework deletes `.cache/`
wholesale on every version bump and dev/production switch, so the data lives
where a `rm -rf .*` — or a "clean the dotfiles" habit — cannot reach it.

Because everything resolves against `process.cwd()`, running the CLI from
somewhere other than the app directory silently gives you a different app. A
generated app's `dev` and `start` scripts run the `bakery` bin with no path
argument for exactly this reason, and this repo's own root scripts `cd
apps/example` first.

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

Two prefixes are ordinary parts of an app, but their contents come from a fixed
directory rather than from wherever the URL points
([packages/core/src/startup.ts](../../packages/core/src/startup.ts)):

| Prefix | Serves | Registered by |
| --- | --- | --- |
| `/api/*` | `<serveRoot>/api` | core (`ApiHandler`) |
| `/uploads/*` | `<cwd>/public` | core (`PublicHandler`) |

Beyond those, `/_*` and `/api/_*` belong to the framework and its plugins, and
`__bakery.` prefixes framework session keys. A file of yours at one of those
paths is unreachable. The complete list of what is claimed today — core and each
bundled plugin — is in
[Routing → Reserved paths](../guides/routing.md#reserved-paths); it is kept in
one place so it cannot drift.

## Files that are never served

Even inside the serve root, a set of globs is refused whenever a file-serving
handler would answer
([packages/core/src/utils/constants.ts](../../packages/core/src/utils/constants.ts)):

The list covers secrets and dotfiles, database and dump files, lockfiles, the
project-describing JSON files, and the generated and tooling directories. The
patterns themselves are written out once, in
[Server config → Blocked paths](../configuration/server-config.md#blocked-paths).

`blocked` in `server.config.ts` **appends** to that list; it cannot shorten it.
A per-host `blocked` behaves slightly differently — it replaces the app-level
additions while still inheriting every default — which is covered in
[Static assets](../guides/static-assets.md#what-is-never-served).

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

The folder layout is what `bun create bakery` generates, and it is the one to
prefer for anything non-trivial. `db:sync --choose=db`
regenerates `schema.ts` from the database; in the folder layout it writes only
`orm/schema.ts` and never touches `orm/index.ts` or `orm/indexes.ts`, so
hand-written declarations survive.

## Generated directories

Both are gitignored and neither should be committed.

**`.cache/`** — safe to delete at any time:

| Subdirectory | Contents |
| --- | --- |
| `ts_cache/` | `.ts` compiled to browser JS |
| `html/` | HTML with the framework's head/body injections already applied |
| `static/` | pre-compressed static assets (`.gz`, `.zst`) |
| `nm_cache/` | bundled node modules served under `/_nm/` |
| `gf_cache/` | fetched Google Fonts CSS and font binaries |
| `virtual/` | the compiled client runtime |
| `tsconfig/` | the generated tsconfig projects, including any a plugin contributed |
| `server.json` | the mode, app version and framework version the cache was built for |

That last file is the invalidation key: on boot, if any of the three differs from
the current process, the cache directory is emptied and recreated
([packages/core/src/core/cache-version.ts](../../packages/core/src/core/cache-version.ts)).
The wipe is per entry and the marker is rewritten **only if nothing survived** —
a success marker written after a partial delete is what once turned a retryable
problem into a permanent one, because the next boot then believed the cache was
current.

**`bakery/`** — not disposable:

| Path | Contents |
| --- | --- |
| `server.db` | the SQLite database, when no `DB_URL` is set |
| `sessions.db` | cookie sessions, plus the tiered cache's spill tier |
| `backups/` | database and schema copies taken before a destructive sync |

`sessions.db` sits here rather than under `.cache/` deliberately, and it used not
to: a framework version bump wiped the cache directory and logged out every user
of every app. It now carries its own schema version, so a format change still
drops sessions and a release no longer does
([packages/core/src/cache/shared-db.ts](../../packages/core/src/cache/shared-db.ts)).
The consequence is that even an app with no ORM creates a `bakery/` directory.

## The framework repo

```
packages/
  core/src/            @bakery-framework/core — no runtime dependencies
    startup.ts         registry population + the startup banner
    router.ts          handleRequest / handleRequestError / processResponse
    handlers/          every request surface, as a Handler subclass
    core/              bakery.ts, config.ts, plugins.ts, jsx.ts, init.ts
    utils/isomorphic/  pure; compiled into the browser bundle as-is
    utils/             server-side helpers (http/, fs, common/)
    client/            the browser runtime
    cache/  logger/  compiler/  plugins/
  orm/src/             @bakery-framework/orm — adapters/, orm/, sync/, backup
  cli/src/             @bakery-framework/cli — the `bakery` bin and mode dispatch
  plugins/{vue,analytics,dashboard}/
apps/
  example/             the bundled demo and end-to-end target
  starter/             a minimal second consumer, public entry points only
```

Directories nest but package names stay flat: `packages/plugins/vue` publishes
as `@bakery-framework/plugin-vue`.

The aliases `@server/*`, `@database/*` and `@plugins/*` appear in some
package-internal tsconfigs but are **not available to applications**. Import
from `@bakery-framework/core`, `@bakery-framework/orm` and `@bakery-framework/plugin-*`.

## Next

- [Routing](../guides/routing.md) — dynamic segments and priority in full.
- [server.config.ts](../configuration/server-config.md) — every option.
- [Architecture](../reference/architecture.md) — the request pipeline.
