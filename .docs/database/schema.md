# Schema Definition

Bakery uses a TypeScript-based schema definition that is both the source of truth for your database structure and the type provider for your query builder. Schema changes are automatically applied to the database on startup.

---

## Defining a Schema

All schema definitions live in `schema.ts` at the project root:

```typescript
// schema.ts
import {
  dateNow,
  index,
  primary,
  unique,
  value,
} from '@database/schema-util'

export namespace DBInfo {
  export const constraints = {
    // Table name → column definitions
    users: {
      id:        primary(),                          // INTEGER PRIMARY KEY AUTOINCREMENT
      username:  value('string', ''),                // TEXT NOT NULL DEFAULT ''
      email:     value('string', ''),                // TEXT NOT NULL DEFAULT ''
      role:      value('string', 'user'),            // TEXT NOT NULL DEFAULT 'user'
      active:    value('boolean', true),             // BOOLEAN NOT NULL DEFAULT TRUE
      createdAt: value('integer', dateNow),          // INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    },

    posts: {
      id:        primary(),
      title:     value('string', ''),
      content:   value('string', ''),
      authorId:  value('integer'),                   // INTEGER NOT NULL (no default)
      published: value('boolean', false),
      createdAt: value('integer', dateNow),
    },

    comments: {
      id:        primary(),
      postId:    value('integer'),
      userId:    value('integer'),
      body:      value('string'),
      createdAt: value('integer', dateNow),
    },
  } as const

  export const indexes = {
    idxUserEmail:     unique('users', 'email'),      // UNIQUE INDEX on users.email
    idxUserUsername:  unique('users', 'username'),   // UNIQUE INDEX on users.username
    idxPostAuthor:    index('posts', 'authorId'),    // INDEX on posts.author_id
    idxCommentPost:   index('comments', 'postId'),   // INDEX on comments.post_id
  } as const

  // TypeScript utility types (do not modify)
  type C = typeof constraints
  export type Table<T extends keyof C> = ExtractTableTypes<C, T>
  export type Optionals<T extends keyof C> = ExtractOptionals<C, T>
  export type Views = ExtractViews<C>
}

// Global type exports for the query builder
export type DBSchema = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Table<T>
}

export type DBOptionals = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Optionals<T>
}
```

---

## Column Definition API

### `value(type, default?, nullable?, autoIncrement?, primary?)`

Defines a regular column.

```typescript
value('string')                // TEXT NOT NULL
value('string', '')            // TEXT NOT NULL DEFAULT ''
value('integer')               // INTEGER NOT NULL
value('integer', 0)            // INTEGER NOT NULL DEFAULT 0
value('boolean', false)        // BOOLEAN NOT NULL DEFAULT FALSE
value('string', null, true)    // TEXT (nullable, no default)
value('integer', dateNow)      // INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
```

**Supported types:**

| Type | SQL Type | TypeScript Type |
|------|----------|----------------|
| `'string'` | `TEXT` | `string` |
| `'integer'` | `INTEGER` | `number` |
| `'number'` | `REAL` / `FLOAT` | `number` |
| `'boolean'` | `BOOLEAN` / `INTEGER` | `boolean` |
| `'buffer'` | `BLOB` | `Buffer` |

### `primary()`

Shorthand for an auto-incrementing integer primary key:

```typescript
primary()
// Equivalent to: value('integer', undefined, false, true, true)
// SQL: INTEGER PRIMARY KEY AUTOINCREMENT
```

### `dateNow`

A special sentinel value that maps to the current Unix timestamp in milliseconds:

```typescript
createdAt: value('integer', dateNow)
// SQL: INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
```

---

## Index Definition API

Indexes are defined in the `indexes` object, separate from column constraints.

### `index(table, columns)`

Creates a standard (non-unique) index:

```typescript
index('posts', 'authorId')                    // single column
index('posts', ['authorId', 'published'])     // composite index
```

### `unique(table, columns)`

Creates a unique constraint index:

```typescript
unique('users', 'email')                     // UNIQUE INDEX on email
unique('users', ['username', 'tenantId'])    // composite unique
```

---

## Extracting TypeScript Types

The `DBInfo` namespace provides type utilities that derive TypeScript types from your schema:

```typescript
// Full row type (all columns required)
type User = DBInfo.Table<'users'>
// → { id: number; username: string; email: string; role: string; active: boolean; createdAt: number }

// Optional fields (columns with defaults or nullable)
type UserOptionals = DBInfo.Optionals<'users'>
// → 'id' | 'role' | 'active' | 'createdAt'  (these can be omitted on insert)
```

These types flow into the query builder and mutation API automatically.

---

## Column Naming Convention

Bakery automatically converts between `camelCase` TypeScript property names and `snake_case` SQL column names:

| TypeScript | SQL Column |
|------------|------------|
| `createdAt` | `created_at` |
| `authorId` | `author_id` |
| `isActive` | `is_active` |

Query results are automatically converted back to camelCase before being returned.

---

## Renaming Columns and Tables

When renaming a column or table, use the `old()` helper to preserve existing data during migration:

```typescript
import { old, primary, value } from '@database/schema-util'

// Rename a column: 'author' → 'authorId'
posts: {
  id:       primary(),
  title:    value('string', ''),
  authorId: old('author', value('integer')),  // rename 'author' column to 'author_id'
}
```

```typescript
// Rename a table: 'blog_posts' → 'posts'
posts: old('blog_posts', {
  id:    primary(),
  title: value('string', ''),
})
```

You can also provide a transform function to convert old data to the new format:

```typescript
authorId: old('author', value('integer'), (oldValue) => Number(oldValue))
```

See [Migrations & Schema Sync →](./migrations.md) for how schema changes are applied.

---

## Global Type Integration

The `DBSchema` and `DBOptionals` types from `schema.ts` are re-exported into the global namespace via `.server/global.d.ts`. This means the query builder and mutation API are automatically typed to your schema without any imports:

```typescript
// No import needed — DBSchema is globally available
const users = await DB.table('users').selectAll('users').array()
// users: Array<{ id: number; username: string; email: string; ... }>
```

---

*[← Database Overview](./overview.md) · [Query Builder →](./query-builder.md)*

*[← Back to README](../../README.md)*
