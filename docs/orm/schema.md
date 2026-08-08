# Schema

A Bakery schema is a set of table declarations written in TypeScript. It is the
input to [`db:sync`](sync.md), which makes the database match it, and — if you
register it — the source of the types the query builder uses.

The framework never imports your schema for types. Everything runs and
typechecks without one; the ORM is simply untyped until you
[register it](#making-the-schema-typed).

## Where the schema lives

Two layouts, probed in this order from the app's working directory
([`sync/load.ts`](../../packages/orm/src/sync/load.ts)):

1. **`orm/`** — `orm/index.ts` is the entry. Tables go in `orm/schema.ts`,
   indexes in `orm/indexes.ts`, and `index.ts` re-exports both.
2. **`schema.ts`** at the root — a single file holding everything.

The folder is preferred because `db:sync --choose=db` regenerates *tables* by
overwriting `schema.ts`. With the folder, your hand-written `indexes.ts` and the
`index.ts` re-exports are never touched. With one file, they are collateral.

To keep the model somewhere else, set `schema` in `server.config.ts`:

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  // A folder containing index.ts …
  schema: 'db/orm',
})
```

or point it at a single file:

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({ schema: 'db/model.ts' })
```

Relative paths resolve against the app's working directory.

**A configured path that does not exist is a hard error, not a fallback.**
`db:sync` prints the resolved path and exits 1
([`sync/index.ts`](../../packages/orm/src/sync/index.ts)). This is
deliberate: an absent schema means "generate one from the database", so falling
back on a typo would sync against nothing and then write a brand-new model at
the typo'd path while your real one sits untouched somewhere else. Omitting the
option entirely still auto-detects, and finding neither default is fine.

## Declaring tables

A table is a value carrying its own name and columns.

```ts
// orm/schema.ts
import { Field, table } from '@bakery/orm'

export const users = table('users', {
  id: Field.Primary(),
  username: Field.Varchar(64),
  email: Field.Varchar(255, null),
  createdAt: Field.Date.now(),
})

export const posts = table('posts', {
  id: Field.Primary(),
  authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
  title: Field.Varchar(255),
  slug: Field.Varchar(255),
  body: Field.Varchar(8192, ''),
  published: Field.Int(0),
  createdAt: Field.Date.now(),
})
```

The name is passed explicitly rather than inferred from the export binding —
inferring it would need a build step or a Proxy.

Because a table is a value, its columns are values too: `posts.authorId` is a
reference that knows it belongs to `posts`. That is what lets `Field.Index()`
take one argument instead of two strings, what lets `Field.Foreign()` name its
target directly, and what makes a typo a compile error rather than a sync-time
surprise.

`table` from `@bakery/orm` declares a table. `DB.table` starts a *query* — see
[Queries](queries.md). They are different functions with the same name.

## Columns

Columns are declared with `Field`. Typing `Field.` lists everything a column can
be, which is the point of it having a name for each case.

| Builder | SQLite | MySQL | Postgres | TypeScript |
| --- | --- | --- | --- | --- |
| `Field.Int(d?)` | `INTEGER` | `INT` | `INTEGER` | `number` |
| `Field.Float(d?)` | `REAL` | `DOUBLE` | `DOUBLE PRECISION` | `number` |
| `Field.BigInt(d?)` | `BIGINT` | `BIGINT` | `BIGINT` | `number` |
| `Field.Text(nullable?)` | `TEXT` | `TEXT` | `TEXT` | `string` |
| `Field.Varchar(n, d?)` | `VARCHAR(n)` | `VARCHAR(n)` | `VARCHAR(n)` | `string` |
| `Field.Bool(d?)` | `INTEGER` | `TINYINT(1)` | `BOOLEAN` | `boolean` |
| `Field.Blob()` | `BLOB` | `BLOB` | `BYTEA` | `Buffer` |
| `Field.Json(nullable?)` | `JSON` | `JSON` | `JSONB` | `unknown` |
| `Field.Uuid(nullable?)` | `VARCHAR(36)` | `VARCHAR(36)` | `VARCHAR(36)` | `string` |
| `Field.Enum(members, d?)` | `VARCHAR(n)` | `VARCHAR(n)` | `VARCHAR(n)` | the union |
| `Field.Date(d?)` | `INTEGER` | `INT` | `INTEGER` | `number` |
| `Field.Primary()` | auto-increment integer key — see [Adapters](adapters.md) | | | `number` |
| `Field.Foreign(target, o?)` | integer + `FOREIGN KEY` | | | `number` |

**`null` as the default means nullable**, which is the one convention to carry
across: `Field.Varchar(64)` is `NOT NULL` with no default, `Field.Varchar(64,
'')` is `NOT NULL` defaulting to empty, and `Field.Varchar(64, null)` is
nullable.

**Modifiers are not chained.** There is no `.nullable().primary()`, because a
builder that is also a column definition breaks inference — while it was being
prototyped, `email` came out `string` instead of `string | null`. The named
constructors cover the real cases without it.

A few carry a constraint worth knowing:

- **`Field.Text` takes no default.** MySQL refuses a literal `DEFAULT` on a
  `TEXT` column, so use `Field.Varchar(n, d)` when you need one. This is not
  hypothetical: it is what previously stopped the shipped schema template from
  syncing against MySQL at all.
- **`Field.Primary()` and `Field.Foreign()` are always integers.** Primary is an
  `INTEGER PRIMARY KEY AUTOINCREMENT`, and a foreign key exists to point at one,
  so its row type is `number` — or `number | null` with `{ nullable: true }`. For
  a UUID key, use `Field.Uuid()` with `Field.Unique()`.
- **`Field.Json`** reads back parsed on MySQL and Postgres and as a raw string on
  SQLite, so its row type is `unknown`. Narrow it where you use it rather than
  trusting a type that would be wrong on one of the three.
- **`Field.Date.now()`** is a marker default emitted as the dialect's "epoch
  seconds now" expression. `Field.now()` is the matching value for an `INSERT` or
  `UPDATE`.

A column is optional on insert when it is nullable, has a default, or
auto-increments. That is what `InferOptionals` computes, and it is why
`Insert.into('posts').values({ … })` does not demand an `id`.

`Field` is the whole vocabulary — there is no lower-level `value()` to drop down
to, because a column descriptor is just an object. The one shape `Field` does
not spell is **nullable *and* defaulted to something other than null**, since a
null default is how you say nullable. Write that one literally:

```ts
export const qty = { type: 'integer', default: 0, nullable: true }
```

That is also exactly what `db:sync --choose=db` emits when it meets such a
column, rather than inventing a helper for it.

## Indexes and unique constraints

Declared as exported values. Anything exported from the schema module that looks
like a constraint is collected, so the export name becomes the index name in the
database.

```ts
// orm/indexes.ts — in the folder layout this file starts with
//   import { posts, users } from './schema'
// The tables are inlined here so the example stands on its own.
import { Field, table } from '@bakery/orm'

const users = table('users', { id: Field.Primary(), username: Field.Varchar(64) })
const posts = table('posts', {
  id: Field.Primary(),
  authorId: Field.Foreign(users.id),
  slug: Field.Varchar(255),
  createdAt: Field.Date.now(),
})

export const usernameUniq = Field.Unique(users.username)
export const slugUniq = Field.Unique(posts.slug)
export const postsByAuthor = Field.Index(posts.authorId)
export const postsByAuthorDate = Field.Index(posts.authorId, posts.createdAt)
```

Both helpers also accept the older string form, which is what `--choose=db`
generates:

```ts
import { Field } from '@bakery/orm'

export const postsByAuthor = Field.Index('posts', ['authorId'])
export const slugUniq = Field.Unique('posts', 'slug')
```

Prefer the column form. The string form cannot catch a typo in either argument
until sync time, if then; the column form carries its own table, so a mistake is
a compile error and rename-symbol reaches every usage. A multi-column constraint
built from columns of two different tables throws at load.

Index names, table names and column names are all snake-cased on the way to SQL.

## Foreign keys

Declare the reference on the column it constrains:

```ts
import { Field, table } from '@bakery/orm'

const users = table('users', { id: Field.Primary(), name: Field.Varchar(64) })

export const posts = table('posts', {
  id: Field.Primary(),
  authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
  // Nullable, so deleting the editor leaves the post with none.
  editorId: Field.Foreign(users.id, { nullable: true, onDelete: 'SET NULL' }),
})
```

Real `FOREIGN KEY` DDL on all three dialects, read back by introspection, with
`ON DELETE` and `ON UPDATE`. Actions default to `NO ACTION`, as SQL does.

**`Field.Foreign` is always an integer** — `number` in the row type, or
`number | null` when nullable — because `Field.Primary()` is always an
`INTEGER PRIMARY KEY AUTOINCREMENT` and a foreign key exists to point at one.

**The target must be a primary key or carry a unique index.** SQL requires it,
and the dialects disagree about how to tell you: MySQL and Postgres refuse the
`CREATE`, while SQLite accepts it and then fails *every insert* with "foreign
key mismatch". `db:sync` checks first and names the offending reference rather
than letting either happen.

Two dialect details worth knowing, both handled for you:

- **SQLite cannot `ALTER` a foreign key in or out** — the constraint is part of
  the table definition — so adding or removing one becomes a table rebuild. The
  printed plan says so before it runs.
- **SQLite enforces foreign keys only when `PRAGMA foreign_keys` is on**, and it
  defaults *off*, per connection. The adapter turns it on for every connection it
  opens; without that a key is stored, reported by introspection, shown in the
  dashboard, and enforces nothing.

### Composite keys

A key spanning more than one column uses `Field.Foreign.composite()`, which is
variadic on both sides. It is separate from `Field.Foreign()` because the two
return different kinds of thing — a column definition that goes *inside* a
table, versus a table-level constraint that goes *beside* one:

```ts
import { Field, table } from '@bakery/orm'

const orders = table('orders', {
  id: Field.Primary(),
  sku: Field.Varchar(32),
})

export const items = table('items', {
  id: Field.Primary(),
  orderId: Field.Int(),
  sku: Field.Varchar(32),
})

export const itemsOrderFk = Field.Foreign.composite(
  items.orderId,
  items.sku,
).references(orders.id, orders.sku, { onDelete: 'CASCADE' })
```

Both sides must name the same number of columns in the same order, and all of one
side must belong to one table; each of those is refused at load with a message
naming the mistake rather than at sync time with a server error.

## Renames and data migration: `old()`

`old()` wraps a column or a table with the name it used to have, so the sync
engine renames instead of dropping and recreating.

```ts
import { Field, old, table } from '@bakery/orm'

export const posts = table('posts', {
  id: Field.Primary(),
  // Was `title` in the database; rename it, keep the data.
  headline: old('title', Field.Varchar(255)),
})
```

An optional third argument transforms the data as it moves. Supplying one turns
the change into a full table rebuild — rows are read, mapped in JavaScript, and
inserted into the new shape:

```ts
import { Field, old, table } from '@bakery/orm'

export const posts = table('posts', {
  id: Field.Primary(),
  // Old rows stored a string; the column is now an integer.
  views: old('viewsText', Field.Int(0), oldValue => Number(oldValue) || 0),
})
```

Remove the wrapper once the sync has run. Wrappers are not meant to accumulate,
and `db:sync` does not expect them to: after a sync in which any were present,
it regenerates the schema file from the database
([`sync/engine.ts`](../../packages/orm/src/sync/engine.ts)).

> **In the `orm/` folder layout, that regeneration overwrites `orm/schema.ts`
> with the single-file `DBInfo` form** — including its own registration block,
> which then collides with the one in `orm/index.ts`. Commit before running a
> sync that involves `old()`, and check `git diff` afterwards. The previous
> contents are also copied to `bakery/backups/schema.<timestamp>.ts`.

## Views

```ts
import { Field, view } from '@bakery/orm'

export const activeUsers = view(
  'active_users',
  'SELECT id, name FROM users WHERE active = 1',
  { id: Field.Primary(), name: Field.Varchar(64) },
)
```

The columns are the shape the `SELECT` returns. They are declared rather than
inferred because nothing here parses SQL, and they are what gives the view a row
type — reading from it is typed exactly like reading a table.

`db:sync` emits `CREATE VIEW` instead of `CREATE TABLE`, diffs the body as
normalised text, and drops and recreates the view when it changes. Views hold no
data, so there is no migration to plan.

**Writes are rejected at compile time.** `InferViews` collects the names and
`Mutation.Tables` excludes them, so `DB.Insert.into('active_users')` does not
typecheck — nor does `Update.table` or `Delete.from`. The database would refuse
the write anyway; refusing it earlier is strictly better.

In the older single-file `DBInfo` layout a view is a table entry carrying a
`_view` key, which is what `--choose=db` writes and what `view()` builds.

## Making the schema typed

Type information reaches the framework by **declaration merging**, not by any
import or global re-export. The app registers itself against
`@bakery/orm/schema-registry`; nothing in the framework imports your schema.

At the bottom of `orm/index.ts`:

```ts no-check — a module augmentation retypes every other example in the shared docs compile
import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as model from './schema'

export * from './schema'
export * from './indexes'

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<typeof model>
      DBOptionals: InferOptionals<typeof model>
      Views: InferViews<typeof model>
    }
  }
}
```

`InferSchema` derives row types, `InferOptionals` derives which columns may be
omitted on insert, and `InferViews` lists view names so mutations cannot target
them.

**Without this block everything still works.** `AppDBSchema` falls back to
`MapOf<MapOf<any>>` ([`schema-registry.ts`](../../packages/orm/src/schema-registry.ts)),
so every table name is accepted and every column is `any`. Queries run, `db:sync`
works, nothing warns. You just get no autocomplete and no compile errors for a
misspelled column. The registration is what buys those back.

The dependency has to point this way. The app depends on the framework, never
the reverse — and the ORM's types are derived from a file that is gitignored and
may not exist.

## The single-file layout

The older form puts everything in one `schema.ts` under a `DBInfo` namespace.
`db:sync --choose=db` generates exactly this, and it is what
[`packages/orm/templates/schema.example.ts`](../../packages/orm/templates/schema.example.ts)
contains:

```ts no-check — a module augmentation retypes every other example in the shared docs compile
import { Field } from '@bakery/orm'
import {
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
} from '@bakery/orm/schema-util'

export namespace DBInfo {
  export const constraints = {
    users: {
      id: Field.Primary(),
      username: Field.Varchar(64, null),
      createdAt: Field.Date.now(),
    },
  } as const

  export const indexes = {
    // No table() values in this layout, so the string form is the one available.
    usersUsernameUniq: Field.Unique('users', ['username']),
  } as const

  type C = typeof constraints
  export type Table<T extends keyof C> = ExtractTableTypes<C, T>
  export type Optionals<T extends keyof C> = ExtractOptionals<C, T>
  export type Views = ExtractViews<C>
}

export type DBSchema = { [T in keyof typeof DBInfo.constraints]: DBInfo.Table<T> }
export type DBOptionals = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Optionals<T>
}

declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: DBSchema
      DBOptionals: DBOptionals
      Views: DBInfo.Views
    }
  }
}
```

Both layouts are supported, and a single-file schema may mix the two: `db:sync`
reads `DBInfo.constraints` when present and otherwise collects `table()` values,
so a project can migrate one table at a time.

## Naming

Write `camelCase` in TypeScript. The ORM snake-cases every identifier on the way
to SQL, so `createdAt` is the column `created_at` and `ecrStudentEntry` is the
table `ecr_student_entry`. Result rows come back with both spellings — the raw
key from the driver plus a camelCase alias — so `row.created_at` and
`row.createdAt` are the same value.

## Next

- [Schema sync](sync.md) — applying the schema, and what it refuses to do
- [Queries](queries.md)
- [Mutations](mutations.md)
