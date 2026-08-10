# Installation

## Requirements

Bakery runs on Bun and only on Bun. It is not a Node framework with a Bun
adapter: `Bun.serve` is the server, `Bun.SQL` is the database driver,
`Bun.Glob` is the router's file matcher and `Bun.build` is the compiler. There
is no Node fallback for any of them.

- **Bun 1.3.14 or newer.** Every package declares `"bun": ">=1.3.14"`, and that
  floor is not a guess — it names the lowest Bun the suite has actually run
  against. Raising it is a major release, because an install that previously
  resolved would stop.
- **Nothing else.** `@bakery-framework/core` has **no runtime dependencies**;
  `@bakery-framework/orm` and `@bakery-framework/cli` depend only on core.

TypeScript is needed for typechecking and editor support, never at runtime —
Bun transpiles TypeScript itself, so there is no build step and no `tsc` in the
run path. A generated app installs it, along with `bun-types`, as dev
dependencies.

## Create an app

```bash
bun create bakery my-app
```

`bun create x` fetches `create-x` from npm and runs it, which is why the
scaffolder is a separate unscoped package rather than another verb on the
`bakery` bin — `@bakery-framework/cli` owns that bin, and it is a dependency of
the app you are trying to create.

At a terminal it asks what to include — the ORM, and any of the three plugins —
the way `bun create vite` does. Every answer is also a flag, because a
scaffolder that can only be driven by a human cannot be put in a Dockerfile:

```bash
bun create bakery my-app --no-orm --plugins vue
```

```bash
bun create bakery my-app --plugins dashboard,analytics
```

```bash
bun create bakery my-app --yes
```

| Flag | Effect |
| --- | --- |
| `--orm` / `--no-orm` | Include `orm/`, `db:sync` and `@bakery-framework/orm`, or leave them out |
| `--plugins <list>` | Comma-separated from `vue`, `analytics`, `dashboard`. `--plugins none` is an explicit empty set |
| `--name <name>` | Package name, when it should differ from the directory |
| `--yes`, `-y` | Take the defaults for anything not passed |
| `--no-install` | Write the files and stop, without running `bun install` |

`--yes` and a non-interactive shell take the same defaults — the ORM in, no
plugins. Passing a flag stops it asking about that one thing only.

The directory argument is a **path**, and `.` means the current directory. It
doubles as the package name unless `--name` says otherwise, so
`bun create bakery @co/app` creates a nested `@co/app/` directory rather than a
scoped package — use `--name` for a scope.

Without the ORM there is no `orm/` and no `db:sync`; the example API route keeps
its posts in memory instead, and `@bakery-framework/orm` is not installed at all
— the CLI treats it as an optional peer, so an app that does not want a database
does not carry one. See
[the CLI reference](../reference/cli.md#the-orm-is-optional) for what the server
does without it.

The dependency ranges it writes are derived from the scaffolder's own version,
so `create-bakery` and the framework it scaffolds can never disagree about which
release you are on.

## What it generates

```
my-app/
  package.json          dev / start / typecheck / db:sync
  tsconfig.json         extends @bakery-framework/core/tsconfig.server.json
  server.config.ts      root, port, and any plugins you chose
  .gitignore
  README.md
  src/                  ← the serve root. Everything here is web-reachable.
    index.tsx           /
    script.ts           /script.js
    api/notes.ts        /api/notes
  orm/                  (with --orm)
    tables.ts           table() declarations — the generator owns this file
    views.ts            view() declarations
    indexes.ts          Field.Index() / Field.Unique() declarations
    index.ts            re-exports the three + the schema type registration
  scripts/db-sync.ts    (with --orm) what `bun run db:sync` runs
```

## Run it

```bash
cd my-app
```

```bash
bun run db:sync
```

That creates `bakery/server.db`, applies the schema and prints what it did.
Skip it without the ORM.

```bash
bun run dev
```

```
[I] process Starting server (PID: 12656)...
[I] serve   Starting server in development mode...
[I] db-sync schema.ts is perfectly synced with Database!
[I] serve   Server running at:
[I] serve     ➜ Local  : http://localhost:3000
[I] serve     ➜ Network: http://10.0.0.6:3000
[I] serve   Rate limit: 100 burst / 10 req/s per IP (default) — set rateLimit: false to disable
```

| Script | What it runs |
| --- | --- |
| `bun run dev` | `bakery --dev` — watcher, live reload, schema check on boot |
| `bun run start` | `bakery` — production mode, no watcher, no implicit sync |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:sync` | `bun run scripts/db-sync.ts` (with the ORM) |

The port resolves `--port` → `PORT` in the environment → `port` in
`server.config.ts` → 3000
([packages/core/src/core/port.ts](../../packages/core/src/core/port.ts)):

```bash
bun run dev --port 8080
```

```bash
PORT=8080 bun run dev
```

Development mode checks the schema on every boot and runs the full sync whenever
the schema sources changed since the last successful one — a content hash under
`.cache/` gates it, and `--sync` forces it
([packages/cli/src/dev.ts](../../packages/cli/src/dev.ts)) — so you rarely need
to run `db:sync` by hand while developing. Production does not sync at boot; see
[the CLI reference](../reference/cli.md).

## What it writes to disk

Two directories appear next to the app, both gitignored:

- **`bakery/`** — `server.db`, `sessions.db` and `backups/`. It is deliberately
  *not* hidden: the framework deletes `.cache/` on its own, so the directory
  holding your data is the one a `rm -rf .*` cannot reach
  ([packages/core/src/core/bakery.ts](../../packages/core/src/core/bakery.ts)).
- **`.cache/`** — compiled TypeScript, assembled HTML, bundled node modules,
  fetched Google Fonts, generated tsconfig projects. Safe to delete at any time.
  Bakery clears it itself whenever the app version, the framework version or the
  mode (dev/production) changes
  ([packages/core/src/core/cache-version.ts](../../packages/core/src/core/cache-version.ts)).

An app scaffolded without the ORM still gets a `bakery/` directory, because the
session store lives there — so "no `bakery/` directory" is not evidence that no
database was opened.

## Choosing a database

SQLite is the default and needs no configuration — the file is created at
`bakery/server.db` on first run. To use something else, set `DB_URL` (or
`DATABASE_URL`); the driver is inferred from the URL scheme
([packages/orm/src/adapters.ts](../../packages/orm/src/adapters.ts)):

```bash
DB_URL=postgres://user:pass@localhost:5432/app bun run start
```

All three adapters are tested against real servers in CI, MySQL 8 and Postgres
16 included — see [Adapters](../orm/adapters.md).

## Adding Bakery to an existing project

The scaffolder is the supported path, and three of the details below are load-
bearing in ways that are invisible until something breaks. If you are wiring it
up by hand anyway:

```bash
bun add @bakery-framework/core @bakery-framework/cli @bakery-framework/orm
```

```bash
bun add -d bun-types typescript
```

**`bun-types` is not optional.** `@bakery-framework/core/tsconfig.server.json`
sets `"types": ["bun-types"]` — that is what makes `Bun.*` a type error in
browser code — but core declares no dependencies, so nothing installs the
package the setting names. Without it, `tsc` stops at
`TS2688: Cannot find type definition file for 'bun-types'` before it checks a
single line of yours.

Then `tsconfig.json`:

```json
{
  "extends": "@bakery-framework/core/tsconfig.server.json",
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment"
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "orm/**/*.ts", "server.config.ts"]
}
```

**The three `jsx*` options are repeated on purpose. Remove them and every page
in your app returns 500.**

`tsconfig.server.json` already sets them, because Bakery renders JSX to a string
on the server through its own `createElement` — but **Bun's runtime does not
follow `extends` into a package specifier**, only a relative path. So inheriting
them is enough for `tsc` and not enough for the server: your pages get
transpiled against Bun's default automatic JSX runtime and each one dies with
`Cannot find module react/jsx-dev-runtime`.

The failure is nastier than it sounds because typecheck stays perfectly clean —
`tsc` *does* follow the extends. `apps/starter` in this repo shipped with exactly
this bug, green on both gates, until a page was actually requested.

That everything else `extends` carries is worth having: it pulls in core's
ambient declarations, which is where the global `createElement`, `Fragment` and
`html` come from — you do not import them in a page
([packages/core/tsconfig.server.json](../../packages/core/tsconfig.server.json),
[packages/core/src/global.d.ts](../../packages/core/src/global.d.ts)).

There are two sibling configs for code that is not server code:
`tsconfig.app.json` for browser code, which deliberately has no `bun-types` and
no JSX, and `tsconfig.vue.json` for `.vue` SFCs under `vue-tsc`.

> **The dev server rewrites your `tsconfig.json`.** On every dev boot,
> `syncTSConfigPaths()` replaces `compilerOptions.paths` wholesale with paths
> derived from `importMap` in `server.config.ts`, deletes `baseUrl`, and
> re-serialises the file as plain JSON — losing comments and formatting
> ([packages/core/src/compiler/tsconfig-sync.ts](../../packages/core/src/compiler/tsconfig-sync.ts)).
> It skips the write when the computed paths already match, which is why an app
> with an empty `importMap` is left alone. Do not hand-maintain `paths` there.

## Working on Bakery itself

Only needed if you are changing the framework. Contributors work inside the Bun
workspace, which covers `packages/*`, `packages/plugins/*` and `apps/*`:

```bash
git clone https://github.com/obillekyle/bakery bakery
```

```bash
cd bakery && bun install
```

The example app's schema is gitignored — `.gitignore` ignores `schema.ts` at any
depth, deliberately, because `db:sync --choose=db` rewrites it — so a fresh clone
needs one created from the template before anything will boot or typecheck:

```bash
cp packages/orm/templates/schema.example.ts apps/example/schema.ts
```

The root scripts are thin wrappers that `cd` into `apps/example` first: `bun run
dev`, `bun run serve`, `bun run db:sync`. `bun run test` and `bun run typecheck`
are the two gates, and the baseline for both is zero — no failures, no type
errors across all ten projects. Set `MYSQL_TEST_URL` and `PGSQL_TEST_URL` to
exercise the live-server tests, which skip without them.

## Next

- [Your first app](first-app.md) — build one, file by file.
- [Project structure](project-structure.md) — what each directory means.
</content>
