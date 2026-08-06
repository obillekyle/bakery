# Mutations (INSERT, UPDATE, DELETE)

The `Mutation` class provides a type-safe API for modifying database records. Like the query builder, it automatically converts camelCase property names to snake_case column names and returns camelCase results.

---

## Importing

```typescript
import { Mutation } from '@server/database/mutation'
// or (from API routes)
import { Mutation } from '@database'
```

---

## INSERT

### Insert a Single Row

```typescript
// Insert a new user
const newUser = await Mutation.insert('users', {
  username: 'alice',
  email:    'alice@example.com',
  // role and active use schema defaults
})
// → { id: 1, username: 'alice', email: 'alice@example.com', role: 'user', active: true, createdAt: ... }
```

The inserted row is returned with all fields, including defaults populated by the database.

### Insert Multiple Rows

```typescript
const inserted = await Mutation.insertMany('users', [
  { username: 'bob',   email: 'bob@example.com' },
  { username: 'carol', email: 'carol@example.com' },
])
// → Array<DBSchema['users']>
```

### Insert or Ignore (UPSERT)

```typescript
// Insert if not exists; ignore on conflict
await Mutation.insertOrIgnore('users', {
  username: 'alice',
  email:    'alice@example.com',
})

// Insert or replace (DELETE + INSERT on conflict)
await Mutation.insertOrReplace('users', {
  id:       1,
  username: 'alice-updated',
  email:    'alice@example.com',
})
```

---

## UPDATE

```typescript
// Update by primary key
await Mutation.update('users',
  { role: 'admin' },      // SET clause (partial — only listed columns updated)
  { id: 1 },              // WHERE clause
)

// Update multiple rows matching a condition
await Mutation.update('posts',
  { published: true },
  { authorId: 1 },
)

// Returns number of rows affected
const affected = await Mutation.update('users',
  { active: false },
  { role: 'guest' },
)
console.log(`Deactivated ${affected} guest accounts`)
```

---

## DELETE

```typescript
// Delete by condition
await Mutation.delete('users', { id: 42 })

// Delete multiple rows
const deleted = await Mutation.delete('posts', { published: false, authorId: 1 })
console.log(`Deleted ${deleted} unpublished posts`)
```

---

## Type Safety

All mutation methods are typed against your `DBSchema`:

```typescript
// TypeScript will error if you pass invalid columns or types:
await Mutation.insert('users', {
  username: 'alice',
  email: 'alice@example.com',
  invalidColumn: 'value',  // ❌ Type error: 'invalidColumn' does not exist in schema
})

await Mutation.insert('users', {
  username: 42,  // ❌ Type error: 'username' expects string, got number
})
```

**Optional fields** (those with defaults in the schema) are typed as optional in insert operations:

```typescript
// DBOptionals['users'] = 'id' | 'role' | 'active' | 'createdAt'
// So these can be omitted:
await Mutation.insert('users', {
  username: 'alice',   // required (no default)
  email: 'alice@example.com',  // required (no default)
  // id, role, active, createdAt all optional
})
```

---

## Transactions

Use `DB.transaction()` to wrap mutations in an atomic unit:

```typescript
import { DB } from '@database'
import { Mutation } from '@server/database/mutation'

await DB.transaction(async () => {
  const user = await Mutation.insert('users', {
    username: 'alice',
    email:    'alice@example.com',
  })

  await Mutation.insert('posts', {
    title:    'Hello World',
    content:  'My first post.',
    authorId: user.id,
  })
})
```

If any mutation throws inside the callback, the entire transaction is rolled back.

---

## Practical API Example

```typescript
// api/posts.ts
import { DB } from '@database'
import { Mutation } from '@server/database/mutation'
import { Session } from '@server/core/session'
import { response } from '@server/utils/http'

export default async function(req: Request, body: {
  title?: string
  content?: string
  id?: number
}) {
  const session = Session.from(req)
  const userId = session.get<number>('userId')

  if (!userId) {
    return response.json.error(401, 'Login required')
  }

  switch (req.method) {
    case 'GET': {
      const posts = await DB.table('posts')
        .where({ posts: 'authorId' }, '=', userId)
        .where({ posts: 'published' }, '=', true)
        .selectAll('posts')
        .orderBy({ posts: 'createdAt' }, 'DESC')
        .array()

      return response.json.success('Posts fetched', posts)
    }

    case 'POST': {
      if (!body.title || !body.content) {
        return response.json.error(400, 'title and content are required')
      }

      const post = await Mutation.insert('posts', {
        title:    body.title,
        content:  body.content,
        authorId: userId,
      })

      return response.json.success('Post created', post, 201)
    }

    case 'PUT': {
      if (!body.id) return response.json.error(400, 'id is required')

      const affected = await Mutation.update('posts',
        { title: body.title, content: body.content },
        { id: body.id, authorId: userId },  // ensure ownership
      )

      if (!affected) return response.json.error(404, 'Post not found')
      return response.json.success('Post updated')
    }

    case 'DELETE': {
      if (!body.id) return response.json.error(400, 'id is required')

      await Mutation.delete('posts', { id: body.id, authorId: userId })
      return response.json.success('Post deleted')
    }

    default:
      return response.json.error(405, 'Method not allowed')
  }
}
```

---

*[← Query Builder](./query-builder.md) · [Migrations & Schema Sync →](./migrations.md)*

*[← Back to README](../../README.md)*
