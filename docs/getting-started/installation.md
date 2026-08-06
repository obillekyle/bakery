# Installation

## Requirements

Bakery runs on Bun and only on Bun. It is not a Node framework with a Bun
adapter: `Bun.serve` is the server, `Bun.SQL` is the database driver,
`Bun.Glob` is the router's file matcher and `Bun.build` is the compiler. There
is no Node fallback for any of them.

- **Bun.** `package.json` declares `"bun": ">=1.0.0"`, but that field
  understates it. The SQLite adapter opens connections with
  `new SQL(filename, { adapter: 'sqlite' })`
  ([packages/orm/src/adapters/sqlite.ts](../../packages/orm/src/adapters/sqlite.ts)),
  and the sync engine uses `await using`. The repo pins `bun-types ^1.3.14`.
  Use a current Bun (1.3 or newer); older releases will fail at runtime rather
  than at install.
- **TypeScript ^6.0.3**, declared as a peer dependency. Only needed for
  typechecking and editor support — Bun transpiles TypeScript itself, so there
  is no build step and no `tsc` in the run path.

Nothing else. `@bakery/core` has **no runtime dependencies**; `@bakery/orm` and
`@bakery/cli` depend only on core.

## Bakery is not on npm yet

There is no `bun add bakery` and no `bun create bakery`. The packages are
unpublished — export maps, the package names and the
`@bakery/orm/schema-registry` module name that your `schema.ts` writes into are
all still free to change, and publishing freezes them
([MONOREPO.md](../../MONOREPO.md), "Remaining before a first publish", item 10).
A scaffolder is explicitly deferred until after that, because its whole job is
pulling published packages.

So today you install Bakery by cloning the repo and working inside the Bun
workspace. The workspace covers `packages/*`, `packages/plugins/*` and `apps/*`,
so any directory you create under `apps/` becomes a linked consumer.

## Get it

```bash
git clone https://github.com/obillekyle/bun-server bakery
```

```bash
cd bakery && bun install
```

`bun install` links the workspace packages into each app's `node_modules` and
puts the `bakery` binary (owned by `@bakery/cli`) on each app's path as
`node_modules/.bin/bakery`.

## Create the schema files a fresh clone is missing

The root `.gitignore` ignores `schema.ts` **at any depth**
([.gitignore:7](../../.gitignore)). That is deliberate — the file belongs to
the application and `db:sync --choose=db` rewrites it — but it means a fresh
clone does not contain:

- `apps/example/schema.ts`
- `apps/starter/orm/schema.ts`

Neither app will typecheck or boot until you create them. `@bakery/orm` ships
the template:

```bash
cp packages/orm/templates/schema.example.ts apps/example/schema.ts
```

For `apps/starter`, which uses the newer `orm/` folder layout, write
`apps/starter/orm/schema.ts` with the two tables its `orm/indexes.ts` imports
(`users` with `username`, `posts` with `authorId`, `slug`, `createdAt`). See
[Your first app](first-app.md) for the shape.

> This is a genuine rough edge, not a documentation quirk. `bun run typecheck`
> includes `apps/starter/tsconfig.json`, whose `include` covers `orm/**/*.ts`,
> and `orm/index.ts` does `import * as model from './schema'`. A clone with no
> `orm/schema.ts` fails that typecheck with TS2307.

## Run the bundled example

The root `package.json` scripts are thin wrappers that `cd` into
`apps/example` and run its scripts. They are not generic — running them changes
directory into the example app, whatever you were working on.

```bash
bun run dev
```

```bash
bun run serve
```

```bash
bun run db:sync
```

Under the hood, `apps/example/package.json` runs the CLI entry directly:

| Script | Command |
| --- | --- |
| `dev` | `bun --smol run ../../packages/cli/src/index.ts --dev` |
| `serve` | `bun --smol run ../../packages/cli/src/index.ts` |
| `db:sync` | `bun --smol run ../../packages/orm/src/sync` |

Once installed, the binary works too, from inside an app directory:

```bash
cd apps/example && bunx bakery --dev
```

`bun run dev` prints the port it bound and the LAN addresses it is reachable on.
The example is configured for port 3000, the starter for 3100. **There is no
`--port` flag** — the port comes from `PORT` in the environment, then
`port` in `server.config.ts`, then 3000
([packages/cli/src/worker.ts](../../packages/cli/src/worker.ts)):

```bash
PORT=8080 bunx bakery --dev
```

Development mode runs schema sync on every boot before the server starts
([packages/cli/src/dev.ts](../../packages/cli/src/dev.ts)), so you rarely need
to run `db:sync` by hand while developing. Production does not; see
[the CLI reference](../reference/cli.md).

## What it writes to disk

Two directories appear next to the app you ran, both gitignored:

- **`.data/`** — `server.db` (the SQLite database), `shared-cache.db` (the
  tiered cache's backing store) and `backups/`. This is *not* under `.bakery`
  on purpose: cache is disposable, the database is not, and one shared parent
  would mean clearing a cache could destroy data
  ([packages/core/src/core/bakery.ts](../../packages/core/src/core/bakery.ts)).
- **`.bakery/cache/`** — compiled TypeScript, assembled HTML, bundled node
  modules, fetched Google Fonts. Safe to delete at any time. Bakery clears it
  itself whenever the framework version or the mode (dev/production) changes
  ([packages/core/src/core/config.ts](../../packages/core/src/core/config.ts)).

## Verify

```bash
bun run test
```

```bash
bun run typecheck
```

The baseline for both is zero: no failures, no type errors across all nine
projects. Two ORM tests skip unless `MYSQL_TEST_URL` / `PGSQL_TEST_URL` are set,
which is expected locally.

## Editor and typechecking setup

An app extends the tsconfig that ships with core:

```json
{
  "extends": "@bakery/core/tsconfig.app.json",
  "include": ["src/**/*.ts", "src/**/*.tsx", "orm/**/*.ts", "server.config.ts"]
}
```

That config is not a convenience. It sets `jsx: "react"` with
`jsxFactory: "createElement"` and `jsxFragmentFactory: "Fragment"`, because
Bakery renders JSX to a string on the server through its own `createElement`.
Without those three settings Bun falls back to the automatic runtime and every
`.tsx` page dies with `Cannot find module react/jsx-dev-runtime`. It also pulls
in core's ambient declarations, which is where the global `createElement`,
`Fragment` and `html` come from — you do not import them in a page
([packages/core/tsconfig.app.json](../../packages/core/tsconfig.app.json),
[packages/core/src/global.d.ts](../../packages/core/src/global.d.ts)).

> **The dev server rewrites your `tsconfig.json`.** On every dev boot,
> `syncTSConfigPaths()` replaces `compilerOptions.paths` wholesale with paths
> derived from `importMap` in `server.config.ts`, deletes `baseUrl`, and
> re-serialises the file as plain JSON — losing comments and formatting
> ([packages/core/src/compiler/tsconfig-sync.ts](../../packages/core/src/compiler/tsconfig-sync.ts)).
> It skips the write when the computed paths already match, which is why an app
> with an empty `importMap` is left alone. Do not hand-maintain `paths` there.

## Choosing a database

SQLite is the default and needs no configuration — the file is created at
`.data/server.db` on first run. To use something else, set `DB_URL` (or
`DATABASE_URL`); the driver is inferred from the URL scheme
([packages/orm/src/adapters.ts](../../packages/orm/src/adapters.ts)):

```bash
DB_URL=postgres://user:pass@localhost:5432/app bunx bakery
```

Only SQLite is exercised without a live server. MySQL and Postgres have DDL and
round-trip tests, and CI runs them against real containers, but they are the
less-travelled paths — see [Adapters](../orm/adapters.md).

## Next

- [Your first app](first-app.md) — build one from an empty directory.
- [Project structure](project-structure.md) — what each directory means.
