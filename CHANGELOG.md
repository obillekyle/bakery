# Changelog

All notable changes to Bakery are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Versioning

**Every package ships one version, together.** `@bakery/core`, `@bakery/orm`,
`@bakery/cli`, `@bakery/plugin-vue`, `@bakery/plugin-analytics`,
`@bakery/plugin-dashboard` and `create-bakery` are always at the same number,
and a release publishes all seven — including the ones with no changes.

That is a deliberate trade. It costs some no-op releases. It buys the thing a
framework split across seven packages most needs: *"which plugin works with core
4.2?"* has one answer, always, without a compatibility table.

It is also already load-bearing rather than newly chosen. `create-bakery`
derives the `^x.y.z` range it writes into a generated app **from its own
version** (`dependencyRange` in `packages/create/src/template.ts`), so
`create-bakery@4.1.0` scaffolding `^4.0.0` is drift that cannot happen — but
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

## [4.0.0] — unreleased

First published release. Bakery has existed for four major versions as a single
package inside the app it served; 4.0.0 is the first that is installable, so
there is no upgrade path from 3.x and this entry describes what ships rather
than what changed.

### Added

- **Workspace split.** `@bakery/core` (no runtime dependencies), `@bakery/orm`,
  `@bakery/cli`, and three plugins. Each names its public subpaths explicitly;
  there is no wildcard export, so anything unnamed is private from day one.
- **`bun create bakery`** — a scaffolder that declares no dependencies at all
  and emits a working app, pinned to the framework version that generated it.
- **ORM**: three adapters behind one abstract class, a typed query builder,
  schema sync with a migration ledger, `db:rollback` and `db:history`, cursor
  pagination, composite foreign keys, views, set operations and window
  functions.
- **Third-party adapters.** `@bakery/orm/adapters` is public: a package can
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
- **Changing an enum's members does not migrate**, and neither does a column's
  `_enum` list — the members are not part of the column diff, because no adapter
  can report them back identically.
- **Sessions do not survive a framework upgrade.** The session store lives under
  the disposable `.cache/`, which is cleared whenever the framework version
  changes.

[Unreleased]: https://github.com/obillekyle/bun-server/compare/v4.0.0...HEAD
[4.0.0]: https://github.com/obillekyle/bun-server/releases/tag/v4.0.0
