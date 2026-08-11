# Changelog

All notable changes to Bakery are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

**Every package ships one version, together.** `@bakery-framework/core`, `@bakery-framework/orm`,
`@bakery-framework/cli`, `@bakery-framework/plugin-vue`, `@bakery-framework/plugin-analytics`,
`@bakery-framework/plugin-dashboard` and `create-bakery` are always at the same number,
and a release publishes all seven — including the ones with no changes.

That is a deliberate trade. It costs some no-op releases. It buys the thing a
framework split across seven packages most needs: _"which plugin works with core
1.2?"_ has one answer, always, without a compatibility table.

It is also already load-bearing rather than newly chosen. `create-bakery`
derives the `^x.y.z` range it writes into a generated app **from its own
version** (`dependencyRange` in `packages/create/src/template.ts`), so
`create-bakery@1.1.0` scaffolding `^1.0.0` is drift that cannot happen — but
only while the numbers move together. `tests/conventions.test.ts` fails if any
package drifts, so the policy is enforced rather than remembered.

Semver applies to the **public export map**, which is the whole of what a
consumer can reach: the subpaths named in each `package.json`, and nothing else.
Adding a subpath is a minor; removing or narrowing one is a major. Internal
modules are not covered, which is exactly why the wildcard export was removed
before the first publish.

`engines.bun` is a floor, not a guess: it names the lowest Bun the suite has
actually run against. Raising it is a **major**, because an install that
previously resolved will stop.

Release with `bun run release <version>` — it refuses a dirty tree, runs the
gates, bumps all seven, and rolls the `Unreleased` section into the new heading.

## [Unreleased]

## [1.2.3] — 2026-08-11

## [1.2.2] — 2026-08-11

### Fixed

- **`--migrate` converts an existing `schema.ts`**, not only a project with no
  schema at all. The old file is *moved* to `bakery/backups/`, not deleted —
  `loadSchema` prefers `orm/index.ts`, so a leftover `schema.ts` would be ignored
  rather than used, which is the quiet kind of wrong. Generation is from the
  database alone now: passing the loaded schema in made view nullability
  reconcile against the very file being replaced, so the result depended on what
  happened to be there.
- **Foreign keys read as `Field.Foreign(sections.id, { nullable: true })`** in
  the folder layout, rather than a hundred-character object literal. That needs
  the parent's table value in scope, so tables are emitted parents-first; a
  reference cycle — legal SQL — falls back to the literal rather than emitting a
  `const` used before its declaration.
- **A generated object-literal column carries `as const`.** `table()` takes
  `C extends Record<string, unknown>`, a constraint that does not preserve
  literals, so `type: 'integer'` widened to `type: string` and `InferSchema` had
  nothing to match — every column spelled that way, which since 1.2.1 meant every
  referencing column, inferred as a string. Invisible in the single-file layout,
  whose whole object is already `as const`. It surfaced as 28 "number is not
  assignable to string" errors in an app that had typechecked clean minutes
  earlier on the same data.

## [1.2.1] — 2026-08-11

### Fixed

- **A schema generated from a database round-trips.** `db:sync --choose=db`
  produced a schema whose very next sync proposed rebuilding the table it had
  just been read from — `DANGER ZONE … Tables to rebuild: posts`. Three losses,
  all in the generator, none in introspection:

  - a NOT NULL column with no default regenerated as nullable, because the
    default was read without the `nullable` flag beside it, and in `Field`'s
    vocabulary a null default *means* nullable;
  - a foreign key vanished, because `getForeignKeys()` was never consulted — the
    key stayed in the database while the schema stopped mentioning it, so the
    next sync planned to remove it;
  - in the folder layout, **no indexes were declared at all**, because nothing
    ever wrote `orm/indexes.ts`. A TS-wins sync drops what the schema does not
    mention, so three indexes in meant three queued for dropping.

  A pre-existing test had pinned the first of these as known behaviour, calling
  it a "long-standing round-trip loss".

- **`db:sync --migrate`** — one command for a database Bakery did not create. It
  writes the schema from what is there, creates the `orm/` folder if there is
  none, seeds the ledger, and **changes no tables**. Distinct from
  `--choose=db`, which sits after the "no changes" early return (so it does
  nothing on a database that already matches, the usual case when adopting one)
  and never records the ledger, leaving the next sync to diff against
  introspection — the one place enum member changes are invisible.

  **A new flag is a minor by the policy at the top of this file, and this ships
  as a patch** at the maintainer's explicit direction. Recorded rather than done
  quietly, which is what the 1.1.0 entry below asks of every later deviation.
  The argument for it: the flag is additive, nothing existing changes behaviour,
  and the fixes it travels with are repairs to a command that was already
  documented as working.

## [1.2.0] — 2026-08-10

### Added

- **CORS.** `cors` in `server.config.ts`. Preflights are answered before
  routing; headers are applied in the one funnel every response passes through.
  No default — absent means no headers, which is the browser's own default.
- **Request body validation.** `defineRoute({ body: schema }, handler)`, taking
  a Standard Schema (zod, valibot, arktype) or a plain function. No schema
  library is bundled or depended on. The one-argument form is unchanged.
- **Server-sent events.** `sse(req, stream => …)`, with correct multi-line
  framing, keep-alive comments, cleanup on disconnect, and the nginx buffering
  opt-out.
- **`--port`.** `--port N`, `--port=N`, `-p N`, `-p=N`, resolving flag → `PORT` →
  `port` in `server.config.ts` → 3000. There was no port flag before, and every
  framework a developer arrives from has one. It folds into `process.env.PORT` in
  the CLI entry, which is what makes it reach the dev worker and the cluster
  workers — they inherit the environment, and their argv is built explicitly.
  Malformed values are refused by the same rule `PORT` uses rather than a second
  one, and `--port` with no value is an error rather than a flag that does
  nothing.
- **Generated tsconfig projects**, written to `.cache/tsconfig/` on dev boot,
  with plugins able to contribute one of their own — which is how `.vue` gets a
  project and how `plugin-vue`'s ambient declarations finally reach an app. The
  app's own `tsconfig.json` gains a `references` array and keeps everything else.
  Documented in [the plugin API](docs/plugins/plugin-api.md#contributing-a-tsconfig-project).
- **`sse` and `encodeSSE` are exported from `@bakery-framework/core`**, not only
  from `core/utils/http`. Application code calls `sse` on every streaming route,
  which makes a deep subpath the wrong shape for it. Adding a root export is a
  minor by the policy at the top of this file.
- **Documentation for the three things that had none**: [the `Bakery`
  object](docs/reference/bakery.md), [server-sent
  events](docs/guides/server-sent-events.md) and [CORS](docs/guides/cors.md).
  Four passages elsewhere still stated that CORS and body validation did not
  exist and had to be hand-rolled in middleware; those are corrected.
- **Two stale warnings in the middleware guide are corrected.** It told readers
  not to put authorisation in `config.middleware` at all, because the route
  cache made it run once per path — fixed since, by `alwaysResolve` on
  `MiddlewareHandler`, and verified with a counter on a running server. It also
  documented `config.onRequest` as silently discarding non-HTML responses,
  which `$middleware.test.ts` has pinned as fixed for some time. Both claims
  steered readers away from the working tool.

### Changed

- **Sessions survive a framework upgrade.** The store moved from the disposable
  `.cache/` to `bakery/sessions.db` and carries its own schema version. A
  format change still drops them; a version bump no longer does. An app with no
  ORM now creates a `bakery/` directory where it previously created none.

### Fixed

- **The tsconfig generator no longer breaks every `.tsx` page.** It replaced the
  app's root `tsconfig.json` with a references-only stub, on the reasoning that
  the generated projects carry the JSX options. True for `tsc`; false for **Bun's
  runtime**, which reads `compilerOptions.jsx*` from the root and does not follow
  `references`. Pages then transpiled against the automatic JSX runtime, and the
  symptom was not a 500 — `GET /` answered **200** with
  `{"type":"html","props":{…},"_owner":null,"_store":{}}`, a React element tree
  JSON-encoded because the handler received an object where it expects a string.
  Nothing threw and nothing logged. It also deleted the three options the
  scaffolder writes under a comment saying to keep them. The root is now merged:
  `references` is the only key the generator owns.

  Never caught because the feature had never run — `apps/example` had not had a
  dev boot since it landed.
- **`importMap` aliases no longer reach the server project.** The generator wrote
  the derived `paths` into every project, so a server file could import an alias
  only the browser can satisfy and typecheck clean doing it — an import map is
  served as `<script type="importmap">` and resolved *there*. It is opt-in per
  project now (`importMapPaths`), set on `client` alone. Same class of mistake the
  server/client tsconfig split exists to prevent, one level up.
- **A middleware may reject with `response.json.*`, and it now actually
  rejects.** `MiddlewareHandler` accepted only `instanceof Response`, so the
  framework's own one-envelope idiom — the shape every API route returns — was
  silently ignored and the chain carried on. An auth guard written the way
  [the middleware guide](docs/guides/middleware.md) recommends therefore failed
  **open**: measured against a real server, `response.json.error(401, …)` on
  `/admin` served the protected page with a `200`. On a path with no route the
  same bug surfaced as a `404` HTML error page, with the status and message
  gone, which is the shape it was reported in.

  `Response` and `JsonResponseData` now both stop the chain, and nothing else
  does — widening to "anything truthy" would let an incidental return value halt
  a request. The declared type widened to match, so a config that does this
  typechecks.
- **Enum member changes migrate.** `_enum` was excluded from the column diff, so
  changing the members was a silent no-op. It is compared against the migration
  ledger — not introspection, which reports the underlying `CHECK` constraint
  back in three incompatible shapes and would rebuild the table forever.
- **A generated app can be typechecked.** `tsconfig.server.json` sets
  `types: ["bun-types"]` and core depends on nothing, so nothing installed the
  package that setting names — every scaffolded app stopped at
  `TS2688: Cannot find type definition file for 'bun-types'`. The scaffolder now
  writes `bun-types` and `typescript` as dev dependencies and a `typecheck`
  script. Invisible from inside this workspace, where a root devDependency
  supplied it.
- **The migration ledger is used again.** It stores the table names you
  declared; introspection camelCases everything it reads back. A table or view
  named in snake_case therefore appeared under two spellings, which the shape
  check read as a drifted database — permanently, since the spellings never
  converge. Every app `bun create bakery` generated hit it on the first sync,
  because the generated schema declares `view('published_posts', …)`.

  Falling back to introspection is safe, so nothing broke loudly; it just
  withdrew what the ledger is for, and the enum diff above is gated on
  `ledgerSource === 'ledger'`. A second bug hid behind the first: with the names
  reconciled, every consumer of "current state" still looked tables up by
  camelCase, so the view was recreated on every sync. The ledger is now
  normalised on read, which repairs ledgers written by earlier versions too.
- **The generated example route respects its own foreign key.** It inserted a
  hardcoded `authorId: 1` into a freshly synced database with no users in it, so
  the first `POST` a reader tried — following the generated README — answered
  500 with `FOREIGN KEY constraint failed`.
- The client type layer no longer needs `bun-types`.

## [1.1.1] — 2026-08-10

## [1.1.0] — 2026-08-10

### Changed

- **`@bakery-framework/core/tsconfig.app.json` now means client-side code only**
  — no `bun-types`, no JSX, so `Bun.*` in a file bound for the browser is a type
  error rather than a runtime one. Server code extends the new
  `tsconfig.server.json`; Vue SFCs extend the new `tsconfig.vue.json`.

  **Shipped as a minor, and that is a deliberate deviation from the policy at
  the top of this file.** Narrowing what an existing subpath provides is a major
  by that rule, and apps generated by `create-bakery@1.0.x` do extend
  `tsconfig.app.json` for server code — their typecheck loses `bun-types` until
  one line is repointed.

  Taken as a minor anyway, for two reasons. The framework is a day old with a
  single adopter, so the blast radius is one repository. And the pre-split
  Bakery already had exactly this separation — `.server/tsconfigs/` held `app`,
  `jsx`, `server` and `vue`, and `tsconfig.app.json` meant _client_ there. The
  1.0.x behaviour, one config carrying `bun-types` everywhere, was the
  regression the package split introduced. Protecting a version number would
  have made that regression permanent.

  Written down rather than done quietly, so the next deviation has to argue for
  itself too.

## [1.0.2] — 2026-08-10

### Fixed

- The release pipeline itself, in three ways that only a real run could find: a
  workflow file GitHub rejected outright, a cache-wipe test whose fixture only
  worked on Windows, and a tag push that could never trigger the publish it was
  supposed to gate.

## [1.0.1] — 2026-08-10

**Tagged but never published.** The automated release worked up to the last
step and stopped silently: a tag pushed with the default `GITHUB_TOKEN` cannot
trigger a workflow, so `publish.yml` never ran. The tag is kept as the record
of what was cut; npm goes 1.0.0 → 1.0.2.

## [1.0.0] — 2026-08-10

First published release, and **the version number restarts here.** Bakery had
reached 4.x as a single package living inside the app it served — private
numbering, no installable artifact, no consumers. This is the first release
anyone can install, under a new scope (`@bakery-framework/*`), so it is 1.0.0
rather than 4.0.0: publishing 4.0.0 as a package's first version implies three
prior majors a user could have been on, and there are none.

There is consequently no upgrade path from the old 3.x/4.x, and this entry
describes what ships rather than what changed.

### Added

- **Workspace split.** `@bakery-framework/core` (no runtime dependencies), `@bakery-framework/orm`,
  `@bakery-framework/cli`, and three plugins. Each names its public subpaths explicitly;
  there is no wildcard export, so anything unnamed is private from day one.
- **`bun create bakery`** — a scaffolder that declares no dependencies at all
  and emits a working app, pinned to the framework version that generated it.
  It asks what to include — the ORM, and any of the three plugins — and every
  answer is also a flag (`--orm` / `--no-orm`, `--plugins vue,dashboard`,
  `--yes`), so it drives from a Dockerfile as well as from a terminal. The
  prompts are written from scratch rather than pulled in, for the same reason
  the package has no dependencies at all.
- **The ORM is optional.** `@bakery-framework/orm` is an optional peer of `@bakery-framework/cli`,
  so an app scaffolded without a database does not install one. Absence and
  breakage stay distinct: with no ORM the server simply runs without one, but a
  _present_ ORM that fails to initialise is still a fatal boot error, so a
  misconfigured `DB_URL` cannot be silently reinterpreted as "no database".
- **ORM**: three adapters behind one abstract class, a typed query builder,
  schema sync with a migration ledger, `db:rollback` and `db:history`, cursor
  pagination, composite foreign keys, views, set operations and window
  functions.
- **Third-party adapters.** `@bakery-framework/orm/adapters` is public: a package can
  register a driver through the same API the three built-ins use, with the
  driver name added by declaration merging rather than by widening a union.
- **Query observability** — `setQueryObserver`, off by default, parameters
  withheld unless asked for.
- **Documentation** under `docs/`, every example compiled against the real
  packages by `tests/docs-examples.test.ts`, so a broken snippet fails the
  build rather than the reader.

### Known limitations

Stated here rather than discovered later:

- **Bun only, and not marginally.** `Bun.serve` is the server; 37 of core's 87
  non-test files call `Bun.*` directly. There is no Node fallback and none is
  planned.
- **Packages ship TypeScript source**, with no build step. Consumers get types
  from the source itself. This is one-way: moving to compiled output later
  would change how every consumer resolves the package.
- **`iterate()` pages, it is not a cursor.** Bun exposes no streaming query API,
  so the statement is wrapped in a derived table and walked in chunks. Memory is
  bounded; chunk boundaries are stable only under a total order.
- **`FULL OUTER JOIN` is unavailable on MySQL**, which has never had it. The
  builder refuses at the call site rather than emitting SQL the server rejects.
- **`INTERSECT ALL` / `EXCEPT ALL` are unavailable on SQLite.**
- ~~**Changing an enum's members does not migrate.**~~ Fixed in the Unreleased
  section below: `_enum` joins the column diff, compared against the ledger
  rather than introspection.
- ~~**Sessions do not survive a framework upgrade.**~~ Fixed below: the store
  moved out of the disposable cache directory and is keyed on its own schema
  version.

[Unreleased]: https://github.com/obillekyle/bakery/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/obillekyle/bakery/releases/tag/v1.0.1
[1.0.0]: https://github.com/obillekyle/bakery/releases/tag/v1.0.0
