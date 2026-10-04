# Migrations

Migrations mode makes SQL files the source of truth for the schema. `db:migrate`
applies the files that have not run yet, in order, and `db:sync` checks the
declared tables against the database and changes nothing. It is for a schema that holds what the [declarations](schema.md)
cannot say: a CHECK constraint beyond an enum, a trigger, a partial unique
index, grants. Classic [schema sync](sync.md) would drop those, since it makes
the database match the declarations exactly.

Turn it on with the folder that holds the files:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  migrations: 'migrations',
})
```

The command is a script beside `db:sync`
([`packages/orm/src/migrate/index.ts`](../../packages/orm/src/migrate/index.ts)):

```ts no-check: an app script; this repository has no migrations folder to point it at
// scripts/db-migrate.ts
import { migrate } from '@bakery-framework/orm/migrate'

process.exit(await migrate())
```

```json
{
  "scripts": {
    "db:migrate": "bun run scripts/db-migrate.ts"
  }
}
```

| Command | What it does |
| --- | --- |
| `bun run db:migrate` | Applies the files that have not run |
| `bun run db:migrate --status` | Lists them, and applies nothing |

## Files

A migration is named `<number>_<name>.sql`: `0001_campuses.sql`,
`0002_one_main_campus.sql`. Files run in the order of their numbers, so `9_x`
comes before `10_y`, and by name where two share a number, which is what two
branches that each added a `0007_` file produce when they merge.

```sql
CREATE TABLE campuses (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  is_main boolean NOT NULL DEFAULT false
);

-- Exactly one main campus.
CREATE UNIQUE INDEX one_main_campus ON campuses (is_main) WHERE is_main;
```

Each file runs once. Any of these stops the run before anything is applied:

- A `.sql` file not named `<number>_<name>.sql`. Skipped, it would be a schema
  change that never happens. Files of any other kind are left alone.
- A file that has run and since changed. Undo the edit, and write the change as
  a new migration.
- A file that has run and is gone from the folder.
- A new file that sorts before one that has already run. Renumber it to sort
  after.

## Transactions

On Postgres and SQLite each file runs in a transaction of its own, with its
ledger row written inside it. A file that fails is undone whole, the run stops
there, and the files after it wait.

MySQL commits each DDL statement as it runs, and no transaction can undo one. A
file that fails halfway there leaves the statements before the failure
applied, and the message says to check the database before running it again.

`BEGIN`, `COMMIT`, `END`, `ROLLBACK`, `SAVEPOINT` and `START TRANSACTION` at
the top level of a file stop the run on Postgres and SQLite: they would commit
part of the file and leave the rest, and its ledger row, outside. Function
bodies, trigger bodies and strings are not read as statements.

A statement no transaction can hold, such as `CREATE INDEX CONCURRENTLY`, goes
in a file of its own whose first line opts out:

```sql
-- bakery:no-transaction
CREATE INDEX CONCURRENTLY campuses_name ON campuses (name);
```

Such a file may hold that one statement, since a failure halfway through
anything longer cannot be undone.

## The ledger

The runner records each file in `__bakery_migrations`, which it creates: the
file name, a SHA-256 checksum, when it ran (Unix seconds) and how long it took.
The checksum is taken after removing a byte-order mark and CRLF line endings,
so a checkout with `core.autocrlf` does not make every applied file look
edited.

Classic sync knows the table: a migrated database synced without migrations
mode does not list it as a table the schema forgot.

## Roles and connections

`db:migrate` connects with `DB_MIGRATE_URL` when it is set, and `DB_URL`
otherwise. The two let migrations run as the role that owns the schema while
the app connects as one with only the grants it needs, which a migration can
then give it:

```sql
GRANT SELECT, INSERT ON audit_events TO app;
```

A run takes a lock before it reads the ledger: an advisory lock on Postgres,
`GET_LOCK` on MySQL. A second run started meanwhile, by a second deploy, waits
for it and then finds nothing to do. SQLite serializes writers on its own. The
lock belongs to a session, so the runner's connection pool is one connection.

## What db:sync checks

In migrations mode the [declarations](schema.md) only type queries, so
`db:sync` checks them against the database and changes nothing. It reads the
catalog alone, as the app's own role: on Postgres `pg_catalog` rather than
`information_schema`, which hides a table the role holds no privilege on, and
the primary key of one it can only read.

A declared column is a mismatch when a query typed by it would be wrong about
the column:

- the table or the column is not in the database;
- the type is not one the declaration accepts. A `Field.Int()` accepts
  `integer` and `smallint` but not `bigint`, which Bun returns as a string. A
  width or precision the declaration states is held to exactly, and one it
  leaves out is not asked about;
- the declaration and the database disagree about NULL (a view's columns are
  exempt, since catalogs report every one of them nullable);
- the declared primary key is not the database's.

A native enum's labels are compared with the declared members. A column or a
table the database has and the declarations leave out is not a mismatch:
queries simply never name it.

For a type the rest of `Field` has no spelling for, declare the SQL type and
what the driver returns:

```ts
import { Field, table } from '@bakery-framework/orm'

export const campuses = table('campuses', {
  id: Field.Primary(),
  name: Field.String(),
  weight: Field.Sql<string>('numeric(5,2)'),
  tags: Field.Sql<string[]>('text[]', { optional: true }),
  openedAt: Field.Sql<Date>('timestamptz', { optional: true }),
  closedAt: Field.Sql<Date>('timestamptz', { nullable: true }),
})
```

`optional` says the database fills the column when an insert leaves it out.
The SQL type may use any spelling the database accepts: `timestamptz` is
compared as `timestamp with time zone`, `int[]` as `integer[]`.

```
W campuses.weight: declared a float (double precision or real), the database has numeric(5,2).
E 1 mismatch(es) between the declared tables and the database (migrations mode, migrations).
```

## What else changes

| | In migrations mode |
| --- | --- |
| `db:sync` | Checks, changes nothing, and exits 1 on a mismatch |
| The dev server's boot | Checks on every boot, reports, and serves |
| `bakery --sync` | Checks, and refuses to serve on a mismatch |
| `db:rollback` | Refuses: write a migration that undoes the change |
