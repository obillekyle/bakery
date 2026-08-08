# Schema sync

`db:sync` compares your [schema](schema.md) against the live database and makes
one of them match the other. There are no migration files: the schema is the
desired state, and the diff is computed each time from what the database
actually reports.

```bash
bun run db:sync
```

The script runs `@bakery/orm/sync`
([`packages/orm/src/sync/index.ts`](../../packages/orm/src/sync/index.ts)) from
the app directory, not the repo root.

## When it runs

| Mode | Runs sync? |
| --- | --- |
| `bun run dev` | **Yes, when the schema changed** — skipped when a hash of the schema sources matches the one recorded after the last successful sync |
| `bun run serve` (production) | **No** |
| `bakery --sync` / `-s` | Yes, before the server boots — and forces the dev sync past the hash check |
| `bun run db:sync` | Yes, and then exits |

Development syncs itself: `dev.ts` calls `SyncService.run()` after config and
plugins are loaded and before the worker starts, unless a hash of the schema
sources and the DB target matches the one recorded under `.cache/` after
the previous *successful* sync
([`packages/cli/src/dev.ts`](../../packages/cli/src/dev.ts)). The check fails
closed: unreadable sources, no recorded hash, or a missing local database file
all sync rather than skip, and a failed sync never records the hash — the next
boot re-syncs.

**Production does not.** `prod.ts` calls `initDB()` and nothing else
([`packages/cli/src/prod.ts`](../../packages/cli/src/prod.ts)). A production
deploy applies schema changes only if you ask for it, with `--sync` (or `-s`) on
the server entry, or by running `db:sync` as a separate step. The flag is
ignored inside dev workers and cluster threads, so a `--threads N` boot syncs
once in the master rather than N times in parallel.

Nothing about a running production server will change your database on its own.

## Where the schema comes from

Auto-detected from the app's working directory: `orm/index.ts` first, then
`schema.ts`. Neither present is fine — an empty project syncs nothing.

If `server.config.ts` sets `schema`, that path replaces the probe entirely and
**must exist**. `db:sync` prints the resolved path and exits 1 otherwise:

```
Configured schema path not found: /app/db/orm/index.ts. schema in
server.config.ts must name a file or an orm/ folder that exists; remove it to
auto-detect. Generating one from the database? Create the (empty) file first.
```

Falling back would be worse than failing. An absent schema means "generate one
from the database", so a typo in that one string would sync the app against no
schema at all and then write a fresh model at the typo'd path, leaving the real
one untouched somewhere else. See [Schema](schema.md#where-the-schema-lives).

## Flags

```
bun run db:sync [--choose=db|ts] [--dry-run] [--force-sync] [--help]
```

| Flag | Effect |
| --- | --- |
| `--choose=ts` | Apply the schema to the database. The default. |
| `--choose=db` | The opposite: regenerate the schema file *from* the database. |
| `--dry-run` | Print the planned changes and stop. |
| `--force-sync` | Skip the confirmation prompt; required for destructive changes in production. |
| `--help`, `-h` | Usage. |

## What it detects

Introspection is per-adapter; the diff is not. Working from the database's own
column list, the plan can contain:

- **tables to add** — anything in the schema the database has never seen
- **tables to drop** — anything in the database the schema no longer declares
- **tables to rename** — see below
- **columns to add / drop / rename**
- **tables to rebuild** — a column whose type, nullability or default no longer
  matches. Neither `ALTER` nor a rename can express that, so the table is
  recreated: a temp table with the new definitions, shared columns copied
  across, the original dropped, the temp renamed into place. **Columns that are
  not shared do not survive.**
- **views to update** — a `_view` body that differs, compared as normalised text
- **indexes to add and drop**

Then the phases execute inside a single transaction, in this order: drop
indexes, rename tables, rename columns, drop tables, drop columns, add columns,
rebuild tables, create tables and views, add indexes
([`sync/helpers.ts`](../../packages/orm/src/sync/helpers.ts)). A failure
anywhere rolls back the lot.

## Renames

A table or column that disappears from the schema and a new one that appears are
indistinguishable from a rename, so the engine asks.

The reliable way is to say so in the schema with `old()`, which the engine
resolves before anything is dropped:

```ts
import { Field, old, table } from '@bakery/orm'

export const posts = table('posts', {
  id: Field.Primary(),
  headline: old('title', Field.Varchar(255)),
})
```

Failing that, `db:sync` prompts interactively for every unmatched database
table or column, offering the best fuzzy match (bigram similarity), each
remaining candidate by name, and "drop it". **Answering the prompt wrongly drops
a column.** This is one reason the sync is not automatic in production: there is
nobody at the terminal to answer.

## Destructive changes

A plan is *destructive* if it drops or renames a table, drops or renames a
column, rebuilds a table, updates a view, or drops an index
([`sync/engine.ts`](../../packages/orm/src/sync/engine.ts)).

When it is:

1. The plan is printed under a `DANGER ZONE` heading.
2. **Development** asks for confirmation. Declining exits without touching
   anything.
3. **Production** (`NODE_ENV=production`, and only that) refuses outright
   unless `--force-sync` is passed, and exits 1.
4. A database backup is taken before execution. If the backup did **not**
   happen — an in-memory database, a missing `pg_dump`/`mysqldump`, a thrown
   error — the sync aborts rather than proceeding without a recoverable copy.

Index drops count as destructive on purpose: any index the database has that the
schema does not declare is dropped, which silently removes indexes an operator
added by hand. If you tune indexes in production, declare them in the schema or
they will not survive the next sync.

## Generating a schema from the database

`--choose=db` inverts the direction. Instead of applying the schema, it reads
the database and writes a schema file describing it — the `DBInfo` single-file
layout, including the `declare module` registration block, since a generated
schema that does not register itself would leave the ORM untyped.

```bash
bun run db:sync --choose=db
```

This is also what happens automatically when there is no schema file at all:
point Bakery at an existing database, run `db:sync`, and you get a starting
schema. The write target is the schema file for the layout in use — for the
`orm/` folder that is `orm/schema.ts`, never `orm/index.ts`, so your re-exports
and hand-written `indexes.ts` survive.

The previous schema is copied to `bakery/backups/schema.<timestamp>.ts` first,
keeping the ten most recent. The file is gitignored and the generator rewrites
it wholesale — comments, `_view` bodies and `old()` wrappers included — so this
is the one source file with no other safety net.

The generator follows the layout it is writing into. A single-file project gets
the `DBInfo` namespace and its registration block; an `orm/` folder gets
`table()` values only, because `index.ts` already owns the registration and
`indexes.ts` owns the constraints. It used to emit the `DBInfo` form regardless,
which replaced a folder project's tables with a namespace *and* a second
registration block that collided with the one in `index.ts`.

Regeneration still happens implicitly after any sync involving `old()` wrappers,
so commit first and read the diff.

During `bun run dev`, a schema generated this way exits with code 42, which the
dev watcher treats as "restart me" so the new types load.

## Foreign keys are checked before planning

`db:sync` verifies that every reference targets a primary key or a uniquely
indexed column, and exits 1 naming the offending one if not. SQL requires it,
and the dialects disagree about how they complain: MySQL and Postgres refuse the
`CREATE`, while SQLite accepts it and then fails every insert with "foreign key
mismatch". See [Schema](schema.md#foreign-keys).

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Synced, nothing to do, `--dry-run`, `--help`, or you declined the prompt |
| 1 | Configured schema path missing, a reference to a non-unique target, production without `--force-sync`, or a destructive plan with no backup |
| 42 | Schema regenerated during `bun run dev` — the watcher restarts the worker |

## Next

- [Schema](schema.md) — declaring what you want
- [Adapters](adapters.md) — what the DDL looks like per dialect
- [CLI](../reference/cli.md)
