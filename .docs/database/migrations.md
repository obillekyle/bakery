# Migrations & Schema Sync

Bakery automatically synchronizes your database schema on every server startup. You define the desired schema in `schema.ts`, and Bakery computes the diff against the current database state, applying only the necessary changes.

---

## How Schema Sync Works

When the server starts, `syncSQLSchema()` is called during the startup sequence. It:

1. Reads the `DBInfo.constraints` and `DBInfo.indexes` from `schema.ts`.
2. Introspects the current database schema.
3. Computes a diff (added tables, dropped tables, added columns, dropped columns, changed types, new indexes, dropped indexes).
4. Executes the necessary `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `CREATE INDEX`, and `DROP INDEX` statements.
5. Handles column renames and data migrations using the `old()` helper.

You can also run schema sync independently:

```bash
bun run db:sync
```

---

## Safe Schema Evolution

### Adding a Table

Simply add a new entry to `DBInfo.constraints`:

```typescript
export const constraints = {
  users: { /* existing */ },

  // New table — will be created automatically on next startup
  tags: {
    id:   primary(),
    name: value('string', ''),
    slug: value('string', ''),
  },
} as const
```

### Adding a Column

Add a new field to an existing table definition:

```typescript
users: {
  id:        primary(),
  username:  value('string', ''),
  email:     value('string', ''),
  // New column — will be added via ALTER TABLE ADD COLUMN
  avatarUrl: value('string', '', true),  // nullable, default ''
}
```

> **Note:** SQLite requires `ALTER TABLE ADD COLUMN`. The new column must have a default value or be nullable.

### Dropping a Column

Remove the field from the constraint definition. Bakery will `ALTER TABLE DROP COLUMN` (SQLite 3.35+) or recreate the table with a copy.

### Renaming a Column

Use the `old()` helper to mark the old name. Data from the old column is migrated to the new column:

```typescript
users: {
  id:       primary(),
  username: value('string', ''),
  // Rename 'emailAddress' → 'email'
  email: old('emailAddress', value('string', '')),
}
```

You can provide a transform function for type conversions:

```typescript
// Rename and convert type: old 'score' (string) → 'points' (integer)
points: old('score', value('integer', 0), (oldValue) => parseInt(String(oldValue), 10) || 0),
```

### Renaming a Table

```typescript
// Rename 'blog_posts' → 'posts'
posts: old('blog_posts', {
  id:      primary(),
  title:   value('string', ''),
  content: value('string', ''),
})
```

---

## Index Management

Indexes are defined in `DBInfo.indexes`. Bakery creates missing indexes and removes indexes that are no longer in the definition:

```typescript
export const indexes = {
  // Unique index — will be created as UNIQUE INDEX
  udxUserEmail: unique('users', 'email'),

  // Regular index — will be created as INDEX
  idxPostAuthor: index('posts', 'authorId'),

  // Composite index
  idxPostPublishedAuthor: index('posts', ['published', 'authorId']),
} as const
```

Index names are used as-is in the SQL `CREATE INDEX` statement. Choose descriptive names following a convention:

- `idx` prefix: regular index
- `udx` prefix: unique index
- Table name: the table being indexed
- Column name(s): the indexed columns

---

## Manual Migration Script

For complex migrations that can't be expressed declaratively, run raw SQL before/after startup:

```bash
# Run a one-off migration
bun -e "
import { DB } from '.server/database'
await DB.transaction(async () => {
  await new DB.QBRaw(\"UPDATE users SET role = 'user' WHERE role IS NULL\").array()
})
console.log('Migration complete')
"
```

Or create a dedicated migration script:

```typescript
// scripts/migrate-v2.ts
import { DB } from '.server/database'
import { Mutation } from '.server/database/mutation'

console.log('Running v2 migration...')

await DB.transaction(async () => {
  // Example: backfill a new column
  const users = await DB.table('users').selectAll('users').array()

  for (const user of users) {
    await Mutation.update('users',
      { slug: user.username.toLowerCase().replace(/\s+/g, '-') },
      { id: user.id },
    )
  }
})

console.log('Migration complete.')
process.exit(0)
```

```bash
bun run scripts/migrate-v2.ts
```

---

## Backup Before Migration

Before running schema sync (especially in production), Bakery creates a database backup automatically. Backups are stored in `.server/.data/backups/` and the oldest ones are pruned to keep only `config.backups` (default: 10) most recent copies.

---

## Multi-Database Considerations

Schema sync works with all three supported databases:

| Database | Column Rename | Table Rename | DROP COLUMN |
|----------|:------------:|:------------:|:-----------:|
| SQLite | ✅ (via table copy) | ✅ | ✅ (3.35+) |
| PostgreSQL | ✅ (`ALTER TABLE RENAME COLUMN`) | ✅ | ✅ |
| MySQL | ✅ (`ALTER TABLE CHANGE`) | ✅ | ✅ |

---

*[← Mutations](./mutations.md) · [Plugin API →](../plugins/plugin-api.md)*

*[← Back to README](../../README.md)*
