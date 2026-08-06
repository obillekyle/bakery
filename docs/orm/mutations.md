# Mutations

Three builders, each entered by a different static method:

```ts no-check — signatures, not runnable code
DB.Insert.into(table).values(…)      // INSERT
DB.Update.table(table).set(…).where(…) // UPDATE
DB.Delete.from(table).where(…)       // DELETE
```

`DB.Insert`, `DB.Update` and `DB.Delete` are re-exports of `Mutation.Insert`,
`Mutation.Update` and `Mutation.Delete` — the same classes under two names.
There is no `Mutation.insert()`, `.update()` or `.delete()`.

```ts
import DB, { Mutation } from '@bakery/orm'

const viaDB = DB.Insert.into('posts').values({ title: 'a' })
const viaMutation = Mutation.Insert.into('posts').values({ title: 'a' })
```

Values bind as parameters. Column keys are snake-cased and quoted for the
dialect, exactly as in [Queries](queries.md).

## Insert

```ts
import DB from '@bakery/orm'

const result = await DB.Insert.into('posts')
  .values({ authorId: 1, title: 'Hello', slug: 'hello', body: 'Hi.' })
  .run()

// { lastInsertRowid: 12, changes: 1 }
```

`.values()` is variadic — pass several records for a multi-row insert. The
column list is the union of every record's keys, and a record missing one binds
`null` for it:

```ts
import DB from '@bakery/orm'

await DB.Insert.into('posts')
  .values(
    { authorId: 1, title: 'First', slug: 'first' },
    { authorId: 2, title: 'Second' }, // slug binds NULL
  )
  .run()
```

Columns that are nullable, defaulted or auto-incrementing may be omitted — that
is what `InferOptionals` computes from the schema. Inserting no records at all
throws `Empty insert`.

`.returning()` appends a `RETURNING` clause, which pairs with `.fetch()`:

```ts
import DB from '@bakery/orm'

const created = await DB.Insert.into('posts')
  .values({ authorId: 1, title: 'Hello' })
  .returning('*')
  .fetch<{ id: number; title: string }>()
```

The string passed to `.returning()` is interpolated into the SQL as written. It
is not validated and not quoted — pass a literal, never anything derived from a
request.

## Update

```ts
import DB from '@bakery/orm'

const result = await DB.Update.table('posts')
  .set({ published: 1, title: 'Edited' })
  .where('posts.id', 42)
  .run()

// { lastInsertRowid: …, changes: 1 }
```

`.set()` takes a partial record. `.where()` is required to reach an executable —
`Update.table(t).set({…})` has no `.run()` until a condition is attached, so
there is no way to write an unconditional `UPDATE` by omission.

Conditions chain with `.and()` / `.or()`, and take the same **two** arguments
and the same operator helpers as a query:

```ts
import DB from '@bakery/orm'

await DB.Update.table('posts')
  .set({ published: 0 })
  .where('posts.authorId', 7)
  .and('posts.createdAt', DB.lt(1700000000))
  .run()
```

## Delete

```ts
import DB from '@bakery/orm'

const result = await DB.Delete.from('sessions')
  .where('sessions.userId', 5)
  .and('sessions.expired', true)
  .run()
```

Same shape as update: `.where()` is the only way to get an executable, so a
`DELETE` with no `WHERE` is not expressible through this API.

## Running them

| Method | Returns |
| --- | --- |
| `.run()` | `{ lastInsertRowid, changes }` |
| `.fetch()` / `.first()` | the first returned row, with `.returning()` |
| `.array()` | every returned row, with `.returning()` |
| `.exists()` | `boolean` — does the `WHERE` match anything? (update/delete) |
| `.parse()` | `{ sql, params }`, without running it |

`changes` is the affected-row count. `lastInsertRowid` is the new id after an
insert; Postgres has no such concept natively, so its adapter adds
`RETURNING *` to every insert and reads the first column back — see
[Adapters](adapters.md).

Each builder is a thenable whose default is `.run()`, so `await` alone works:

```ts
import DB from '@bakery/orm'

await DB.Delete.from('sessions').where('sessions.id', 1)
```

Prefer the explicit `.run()`. A builder that is never awaited never executes,
and the explicit call makes that obvious in review.

## The two-argument `.where()` applies here too

`Update` and `Delete` share `parseWhereArgs` with the query builder
([`orm/mutation.ts`](../../packages/orm/src/orm/mutation.ts)). Every warning
from [Queries](queries.md#where-takes-two-arguments) applies:

```ts no-check — deliberately wrong; kept out of the compile because it is the bug being described
DB.Delete.from('sessions').where('userId', '=', 5)
```

That deletes the rows whose `user_id` equals the string `'='` — normally none,
which reads as "it did nothing" rather than as a bug. On an `UPDATE` the same
mistake is worse in the other direction: a condition that matches nothing is
silent, and a condition you *thought* you narrowed may not be narrowed at all.

## A complete API route

Adapted from [`apps/starter/src/api/notes.ts`](../../apps/starter/src/api/notes.ts):

```ts
import { defineRoute, response } from '@bakery/core'
import DB from '@bakery/orm'

export default defineRoute<{ title: string; slug: string; body: string }>(
  async (req, body) => {
    if (req.method === 'POST') {
      const created = await DB.Insert.into('posts')
        .values({ authorId: 1, title: body.title, slug: body.slug, body: body.body })
        .run()

      return response.json.success('created', { id: created.lastInsertRowid })
    }

    const posts = await DB.from('posts')
      .where('posts.published', 1)
      .orderBy('posts.createdAt', 'DESC')
      .limit(20)
      .array()

    return response.json.success('ok', posts)
  },
)
```

`defineRoute` is an identity function — it exists so the declared body shape
types `body.title` and friends without annotating the whole signature. See
[API routes](../guides/api-routes.md) for the handler contract and the JSON
envelope.

## Transactions

Mutations inside `DB.transaction()` use the transaction automatically — the
active connection is per-async-context, not per-argument:

```ts
import DB from '@bakery/orm'

await DB.transaction(async () => {
  const post = await DB.Insert.into('posts')
    .values({ authorId: 1, title: 'Draft' })
    .run()

  await DB.Insert.into('revisions')
    .values({ postId: post.lastInsertRowid, body: '' })
    .run()
})
```

Throwing anywhere in the callback rolls the whole thing back. Anything you
forget to `await` runs outside it.

## Next

- [Queries](queries.md) — reading data
- [Schema](schema.md) — where the column types come from
- [Schema sync](sync.md)
