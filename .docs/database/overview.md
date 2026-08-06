# Database Overview

Bakery includes a built-in database layer that supports SQLite (default), PostgreSQL, and MySQL. It provides a schema definition system, an automatic migration runner, and a fully type-safe query builder — all without external ORM dependencies.

---

## Quick Start

By default, Bakery uses SQLite with no configuration. The database file is stored at `.server/database/server.db`.

```typescript
// api/users.ts
import { DB } from '@database'

export default async function() {
  const users = await DB.table('users').selectAll('users').array()
  return users
}
```

---

## Architecture

The database layer is composed of four components:

| Component | File | Purpose |
|-----------|------|---------|
| **Adapters** | `database/adapters/` | Thin wrappers around SQLite, Postgres, MySQL drivers |
| **Connection** | `database/connection.ts` | Active connection management + `AsyncLocalStorage` for transactions |
| **Query Builder** | `database/query.ts` | Type-safe `QB` class for SELECT queries |
| **Mutation Builder** | `database/mutation.ts` | INSERT, UPDATE, DELETE operations |
| **Schema Sync** | `database/sync/` | DDL diffing and migration runner |
| **Schema Utils** | `database/schema-util.ts` | Column/index/constraint definition helpers |

---

## Selecting a Database

Set the `DB_URL` environment variable in `.env`:

```ini
# SQLite (default — no DB_URL needed)
DB_URL=

# SQLite at a specific path
DB_URL=sqlite:./data/production.db

# PostgreSQL
DB_URL=postgres://user:password@localhost:5432/mydb

# MySQL
DB_URL=mysql://user:password@localhost:3306/mydb
```

Bakery automatically selects the correct adapter based on the URL format. If `DB_URL` is not set, SQLite is used with the default path.

---

## Importing the Database

```typescript
import { DB } from '@database'
// or
import { DB } from '@server/database'
```

`DB` exposes the `QB` class (query builder), `Mutation` class, and raw SQL execution.

---

## Running Raw SQL

For queries that don't fit the query builder:

```typescript
import { DB } from '@database'

// Raw query (returns typed rows)
const result = await new DB.QBRaw<{ count: number }>(
  'SELECT COUNT(*) as count FROM users WHERE active = ?',
  [true]
).array()

console.log(result[0].count)

// Execute within a transaction
await DB.transaction(async () => {
  await new DB.QBRaw('UPDATE users SET active = 0 WHERE last_seen < ?', [cutoff]).array()
  await new DB.QBRaw('DELETE FROM sessions WHERE expired = 1').array()
})
```

---

## Transactions

Wrap multiple operations in a transaction to ensure atomicity:

```typescript
import { DB } from '@database'
import { Mutation } from '@server/database/mutation'

// api/transfer.ts
export default async function(req: Request, body: { from: number; to: number; amount: number }) {
  await DB.transaction(async () => {
    await Mutation.update('accounts', { balance: `balance - ${body.amount}` }, { id: body.from })
    await Mutation.update('accounts', { balance: `balance + ${body.amount}` }, { id: body.to })
  })

  return { success: true }
}
```

If the callback throws, the transaction is rolled back automatically.

---

## Automatic Backups

Bakery automatically creates rolling backups of the SQLite database. The number of backups to retain is configured via the `backups` option in `server.config.ts` (default: `10`).

Backups are stored in `.server/.data/backups/` and are named with a timestamp. Old backups beyond the retention limit are pruned automatically.

---

## Database Directories

| Path | Contents |
|------|----------|
| `.server/database/server.db` | Main application database |
| `.server/.cache/` | Internal cache database (sessions, LRU) |
| `.server/.data/backups/` | Automatic database backups |

---

*[← Sessions](../sessions/sessions.md) · [Schema Definition →](./schema.md)*

*[← Back to README](../../README.md)*
