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
import { dateNow, primary, table, value } from '@bakery/orm'

export const users = table('users', {
  id: primary(),
  username: value('string'),
  email: value('string', null),
  createdAt: value('integer', dateNow),
})

export const posts = table('posts', {
  id: primary(),
  authorId: value('integer'),
  title: value('string'),
  slug: value('string'),
  body: value('string', ''),
  published: value('integer', 0),
  createdAt: value('integer', dateNow),
})
```

The name is passed explicitly rather than inferred from the export binding —
inferring it would need a build step or a Proxy.

Because a table is a value, its columns are values too: `posts.authorId` is a
reference that knows it belongs to `posts`. That is what lets `index()` take one
argument instead of two strings, and what makes a typo a compile error rather
than a sync-time surprise.

`table` from `@bakery/orm` declares a table. `DB.table` starts a *query* — see
[Queries](queries.md). They are different functions with the same name.

## Columns

`value(type, default?, nullable?, autoIncrement?, primary?)`.

| Type | SQLite | MySQL | Postgres | TypeScript |
| --- | --- | --- | --- | --- |
| `'integer'` | `INTEGER` | `INT` | `INTEGER` | `number` |
| `'number'` | `REAL` | `DOUBLE` | `DOUBLE PRECISION` | `number` |
| `'string'` | `TEXT` | `TEXT` | `TEXT` | `string` |
| `'boolean'` | `INTEGER` | `TINYINT(1)` | `BOOLEAN` | `boolean` |
| `'buffer'` | `BLOB` | `BLOB` | `BYTEA` | `Buffer` |

- `value('string')` — `TEXT NOT NULL`, no default.
- `value('string', 'guest')` — adds `DEFAULT 'guest'`.
- `value('string', null)` — nullable, `DEFAULT NULL`. Passing `null` as the
  default is how you make a column nullable in the common case.
- `value('integer', 0, true)` — nullable *and* defaulted.
- `primary()` — shorthand for an auto-incrementing integer primary key. Each
  dialect spells it differently; see [Adapters](adapters.md).
- `dateNow` — a marker default, emitted as the dialect's "epoch seconds now"
  expression. Store timestamps as `value('integer', dateNow)`.

The third argument is nullability: `value('string', null, true)` is nullable,
`value('integer', 0, false)` is not. It used to treat *any* third argument as
"nullable", including an explicit `false`, because the check was
`n !== undefined` rather than `n === true`. Omitting it still means not-null.

A column is optional on insert when it is nullable, has a default, or
auto-increments. That is what `InferOptionals` computes, and it is why
`Insert.into('posts').values({ … })` does not demand an `id`.

## Indexes and unique constraints

Declared as exported values. Anything exported from the schema module that looks
like a constraint is collected, so the export name becomes the index name in the
database.

```ts
// orm/indexes.ts — in the folder layout this file starts with
//   import { posts, users } from './schema'
// The tables are inlined here so the example stands on its own.
import { index, primary, table, unique, value } from '@bakery/orm'

const users = table('users', { id: primary(), username: value('string') })
const posts = table('posts', {
  id: primary(),
  authorId: value('integer'),
  slug: value('string'),
  createdAt: value('integer'),
})

export const usernameUniq = unique(users.username)
export const slugUniq = unique(posts.slug)
export const postsByAuthor = index(posts.authorId)
export const postsByAuthorDate = index(posts.authorId, posts.createdAt)
```

Both helpers also accept the older string form, which is what `--choose=db`
generates:

```ts
import { index, unique } from '@bakery/orm'

export const postsByAuthor = index('posts', ['authorId'])
export const slugUniq = unique('posts', 'slug')
```

Prefer the column form. The string form cannot catch a typo in either argument
until sync time, if then; the column form carries its own table, so a mistake is
a compile error and rename-symbol reaches every usage. A multi-column constraint
built from columns of two different tables throws at load.

Index names, table names and column names are all snake-cased on the way to SQL.

## `foreign()` is exported, and rejected at load

**Do not use it.** `foreign()` is in the export list, has two pleasant calling
forms, and will stop `db:sync` dead:

```
foreign() is declared but not implemented: postsAuthorFk. No adapter emits
FOREIGN KEY DDL, so it would be created as a plain index and then re-diffed on
every sync. Use index() on the column and enforce the reference in your
application.
```

`db:sync` exits 1 the moment it sees one
([`sync/index.ts`](../../packages/orm/src/sync/index.ts)). The reason is
worse than "unimplemented". No adapter emits `FOREIGN KEY` DDL, so a declaration
used to be created as an ordinary index; the next diff then compared `foreign`
in TypeScript against `index` in the database, decided to drop and re-add it,
and — because index drops count as destructive — aborted. The dev server stopped
booting, with nothing pointing at the cause. Failing at load turns that into one
message.

The workaround is an ordinary index plus enforcement in your code:

```ts
import { index, table, value, primary } from '@bakery/orm'

export const posts = table('posts', {
  id: primary(),
  // No FK. The index makes the lookup fast; nothing enforces the reference.
  authorId: value('integer'),
})

export const postsByAuthor = index(posts.authorId)
```

Real support needs per-dialect DDL *and* introspection (SQLite has no
`ALTER TABLE ADD CONSTRAINT`, so it means a table rebuild), and shipping
unverified constraint DDL is the one failure mode that costs someone else their
data.

## Renames and data migration: `old()`

`old()` wraps a column or a table with the name it used to have, so the sync
engine renames instead of dropping and recreating.

```ts
import { old, primary, table, value } from '@bakery/orm'

export const posts = table('posts', {
  id: primary(),
  // Was `title` in the database; rename it, keep the data.
  headline: old('title', value('string')),
})
```

An optional third argument transforms the data as it moves. Supplying one turns
the change into a full table rebuild — rows are read, mapped in JavaScript, and
inserted into the new shape:

```ts
import { old, primary, table, value } from '@bakery/orm'

export const posts = table('posts', {
  id: primary(),
  // Old rows stored a string; the column is now an integer.
  views: old('viewsText', value('integer', 0), oldValue => Number(oldValue) || 0),
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
> contents are also copied to `.data/backups/schema.<timestamp>.ts`.

## Views

A table entry carrying a `_view` key — whose value is the `SELECT` body — is
created with `CREATE VIEW` instead of `CREATE TABLE`, and `db:sync` diffs that
body as normalised text, recreating the view when it changes. `InferViews`
collects those names so mutations cannot target them. There is no dedicated
helper; `--choose=db` writes views in the `DBInfo` form shown below.

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
import {
  dateNow,
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
  index,
  primary,
  unique,
  value,
} from '@bakery/orm/schema-util'

export namespace DBInfo {
  export const constraints = {
    users: {
      id: primary(),
      username: value('string', null),
      createdAt: value('integer', dateNow),
    },
  } as const

  export const indexes = {
    usersUsernameUniq: unique('users', ['username']),
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
