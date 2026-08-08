# @bakery/orm

The database layer for [Bakery](https://github.com/obillekyle/bun-server):
adapters, query builder, schema sync and backups.

**Bun only.** Ships TypeScript source with no build step.

```bash
bun add @bakery/orm
```

## Define a schema

```ts
// orm/schema.ts
import { Field, table } from '@bakery/orm'

export const posts = table('posts', {
  id: Field.Primary(),
  title: Field.Varchar(255, null),
  body: Field.Varchar(8192, ''),
  createdAt: Field.Date.now(),
})
```

Register it so the query builder is typed. Without this block everything still
runs — the columns are just permissive `any`:

```ts no-check — ./schema is the sibling file from the block above, which only exists in a real app
// orm/index.ts
import type { InferOptionals, InferSchema, InferViews } from '@bakery/orm'
import * as model from './schema'

export * from './schema'

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

## Query

```ts
import DB from '@bakery/orm'

const rows = await DB.from('posts').selectAll('posts').array()

await DB.Insert.into('posts').values({ title: 'Hello', body: 'World' }).run()
```

Identifiers are snake_cased on the way to SQL — `createdAt` becomes
`created_at`. Values always bind as parameters.

## Schema sync

```ts
import { SyncService } from '@bakery/orm/sync'

await SyncService.run()
process.exit(0)
```

Diffs the database against your schema and applies the difference, prompting
before anything destructive. `NODE_ENV=production` makes destructive changes
refuse rather than prompt — set it on any deployed host.

## Adapters

SQLite, MySQL and Postgres. **SQLite is the one covered by execution tests**;
the other two are verified against the SQL they emit and against live
round-trips in CI, which is not the same as being battle-tested.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).
