# Query Builder

Bakery includes a fully type-safe, chainable SQL query builder (`DB.QB`) that generates parameterized SQL queries. Column names are automatically converted between camelCase (TypeScript) and snake_case (SQL).

---

## Basic SELECT

```typescript
import { DB } from '@database'

// Select all columns from a table
const users = await DB.table('users').selectAll('users').array()
// → Array<{ id: number; username: string; email: string; ... }>

// Select specific columns with aliases
const names = await DB.table('users')
  .select({ name: { users: 'username' }, email: { users: 'email' } })
  .array()
// → Array<{ name: string; email: string }>
```

---

## Execution Methods

Every query chain ends with one of these execution methods:

| Method | Returns | Description |
|--------|---------|-------------|
| `.array()` | `Promise<T[]>` | All matching rows as an array |
| `.fetch()` | `Promise<T \| undefined>` | First matching row |
| `.column<C>()` | `Promise<C[]>` | First column of each row |
| `.iterable()` | `AsyncIterable<T>` | Stream rows one by one |
| `await query` | `Promise<T[]>` | Alias for `.array()` (via `.then`) |

```typescript
// Get one user
const user = await DB.table('users')
  .where({ users: 'id' }, '=', 42)
  .selectAll('users')
  .fetch()

// Stream large result sets
for await (const user of DB.table('users').selectAll('users').iterable()) {
  process(user)
}
```

---

## WHERE Clauses

```typescript
// Simple equality
DB.table('users')
  .where({ users: 'active' }, '=', true)
  .selectAll('users')

// Comparison operators: '=', '>', '<', '>=', '<=', '<>'
DB.table('posts')
  .where({ posts: 'createdAt' }, '>=', Date.now() - 86400000)
  .selectAll('posts')

// LIKE
DB.table('users')
  .where({ users: 'username' }, 'LIKE', '%alice%')
  .selectAll('users')

// IS NULL / IS NOT NULL
DB.table('posts')
  .where({ posts: 'deletedAt' }, 'IS', 'NULL')
  .selectAll('posts')

// IN / NOT IN
DB.table('users')
  .where({ users: 'id' }, 'IN', [1, 2, 3])
  .selectAll('users')

// AND chaining
DB.table('users')
  .where({ users: 'active' }, '=', true)
  .and({ users: 'role' }, '=', 'admin')
  .and({ users: 'createdAt' }, '>', cutoff)
  .selectAll('users')

// OR chaining
DB.table('users')
  .where({ users: 'role' }, '=', 'admin')
  .or({ users: 'role' }, '=', 'moderator')
  .selectAll('users')
```

---

## SQL String Functions in WHERE

```typescript
// Case-insensitive search using LOWER()
DB.table('users')
  .where({ LOWER: { users: 'email' } }, '=', 'alice@example.com')
  .selectAll('users')

// LENGTH check
DB.table('users')
  .where({ LENGTH: { users: 'username' } }, '>=', 3)
  .selectAll('users')

// UPPER, LOWER, LENGTH, TRIM, CONCAT, SUBSTR, REPLACE supported
```

---

## EXISTS Check

```typescript
const exists = await DB.table('users')
  .where({ users: 'email' }, '=', 'alice@example.com')
  .exists()
// → boolean

// Shorthand
if (await DB.table('users').where({ users: 'email' }, '=', email)) {
  // email exists
}
```

---

## JOIN

```typescript
const postsWithAuthors = await DB.table('posts')
  .join('users', { posts: 'authorId', users: 'id' })
  .selectAll('posts')
  .array()
// → Array<{ id, title, content, authorId, ... }>

// JOIN with alias
const data = await DB.table('posts', 'p')
  .join('users', { p: 'authorId', users: 'id' }, 'u')
  .select({
    title: { p: 'title' },
    author: { u: 'username' },
  })
  .array()
// → Array<{ title: string; author: string }>
```

---

## GROUP BY and HAVING

```typescript
// Count posts per user
const stats = await DB.table('posts')
  .join('users', { posts: 'authorId', users: 'id' })
  .where({ posts: 'published' }, '=', true)
  .groupBy({ posts: 'authorId' })
  .selectAll('posts')
  .selectMath({ postCount: { COUNT: '*' } })
  .having({ postCount: 'postCount' }, '>=', 5)
  .orderBy('postCount', 'DESC')
  .array()
```

---

## ORDER BY and LIMIT

```typescript
const recentPosts = await DB.table('posts')
  .where({ posts: 'published' }, '=', true)
  .selectAll('posts')
  .orderBy({ posts: 'createdAt' }, 'DESC')
  .limit(10, 0)         // LIMIT 10 OFFSET 0
  .array()

// Pagination
const page = 3
const pageSize = 20
const paginated = await DB.table('users')
  .selectAll('users')
  .orderBy({ users: 'createdAt' }, 'DESC')
  .limit(pageSize, (page - 1) * pageSize)
  .array()
```

---

## Math Aggregations (selectMath)

```typescript
const stats = await DB.table('posts')
  .selectAll('posts')
  .selectMath({
    total:   { COUNT: '*' },
    newest:  { MAX: { posts: 'createdAt' } },
    oldest:  { MIN: { posts: 'createdAt' } },
    avgId:   { AVG: { posts: 'id' } },
    idSum:   { SUM: { posts: 'id' } },
  })
  .fetch()

// stats.total, stats.newest, stats.oldest, stats.avgId, stats.idSum
// All typed as `number`
```

---

## Common Table Expressions (CTEs)

```typescript
// WITH clause (CTE)
const activeUsers = DB.table('users')
  .where({ users: 'active' }, '=', true)
  .selectAll('users')

const result = await DB.with(activeUsers, 'active')
  .table('active')
  .selectAll('active')
  .orderBy({ active: 'createdAt' }, 'DESC')
  .limit(10)
  .array()
```

---

## Raw SQL

When the query builder is not expressive enough:

```typescript
import { DB } from '@database'

const result = await new DB.QBRaw<{ count: number }>(
  'SELECT COUNT(*) as count FROM users WHERE created_at > ?',
  [Date.now() - 86400000]
).fetch()

console.log(result?.count)
```

---

## Full API Chaining Reference

```typescript
QB
  .table(name, alias?)              // FROM table [AS alias]
  .join(table, on, alias?)          // INNER JOIN
  .where(left, op, right)           // WHERE
    .and(left, op, right)           // AND
    .or(left, op, right)            // OR
    .groupBy(columns)               // GROUP BY
      .having(left, op, right)      // HAVING
        .orderBy(col, dir)          // ORDER BY
          .limit(n, offset?)        // LIMIT n OFFSET offset
  .select(columns)                  // SELECT specific columns
  .selectAll(alias)                 // SELECT alias.*
  .selectMath(aggregates)           // SELECT COUNT(*) AS total, etc.
  .exists()                         // SELECT EXISTS(...)
  .array()                          // execute → T[]
  .fetch()                          // execute → T | undefined
  .column<C>()                      // execute → C[]
  .iterable()                       // execute → AsyncIterable<T>
```

All methods are available in both `camelCase` and `UPPER_CASE` variants for stylistic preference.

---

*[← Schema Definition](./schema.md) · [Mutations →](./mutations.md)*

*[← Back to README](../../README.md)*
