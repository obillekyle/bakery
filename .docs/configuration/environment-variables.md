# Environment Variables

Bakery reads a `.env` file from the project root automatically on startup via Bun's built-in dotenv loader. No additional configuration is needed.

---

## Creating Your `.env`

Copy the provided example and fill in your values:

```bash
cp .env.example .env
```

The `.env` file is blocked from being served to clients by default. Never commit `.env` to version control.

---

## Variable Reference

### `PORT`

Overrides the `port` setting in `server.config.ts`.

```ini
PORT=8080
```

If set, this takes precedence over `Bakery.config.port`. Useful for deployment environments (e.g., Render, Railway, Fly.io) that inject `PORT` dynamically.

---

### `DB_URL`

Specifies the database connection string. Bakery infers the driver (SQLite, PostgreSQL, MySQL) from the URL format.

```ini
# SQLite (default — leave blank or use a .db path)
DB_URL=

# SQLite at a custom path
DB_URL=sqlite:./data/myapp.db

# PostgreSQL
DB_URL=postgres://user:password@localhost:5432/mydb

# PostgreSQL with SSL
DB_URL=postgresql://user:password@db.example.com:5432/prod?ssl=true

# MySQL
DB_URL=mysql://user:password@localhost:3306/mydb
```

**Driver inference rules:**

| URL Pattern | Inferred Driver |
|-------------|----------------|
| *(blank)* | SQLite (`:memory:` for tests, `server.db` default) |
| `sqlite:...` or `*.db` path | SQLite |
| `postgres://` or `postgresql://` | PostgreSQL |
| `mysql://` or `mysqls://` | MySQL |

---

### `DASHPASS`

Password for the built-in Dashboard plugin. If set, the dashboard requires HTTP Basic Authentication before granting access.

```ini
DASHPASS=your_secure_password_here
```

If left blank, the dashboard is accessible without authentication. **Always set this in production.**

---

### `NODE_ENV`

Standard Node.js environment flag. When set to `test`, Bakery binds to port `0` (OS-assigned) so tests can run in parallel without port conflicts.

```ini
NODE_ENV=test
```

---

## Runtime Environment Flags

These flags are set internally by Bakery and are accessible in server-side code via `import.meta.env`:

| Flag | Type | Description |
|------|------|-------------|
| `import.meta.env.DEV` | `boolean` | `true` when running with `--dev` flag |
| `import.meta.env.PROD` | `boolean` | `true` in production mode |
| `import.meta.env.WORKER` | `boolean` | `true` inside the worker subprocess |
| `import.meta.env.TEST` | `boolean` | `true` when `NODE_ENV=test` |
| `import.meta.env.MODE` | `string` | `'development'`, `'production'`, or `'dev-worker'` |
| `import.meta.env.SERVE_ROOT` | `string` | Resolved absolute path of the `root` directory |

These flags are also inlined into compiled browser assets by the transpiler, enabling dead-code elimination. For example:

```typescript
// This block is eliminated from browser bundles in production
if (import.meta.env.DEV) {
  console.log('[debug]', data)
}
```

---

## Accessing Environment Variables

In server-side code, use `process.env` or `Bun.env`:

```typescript
// api/config.ts
export default function() {
  const dbUrl = process.env.DB_URL
  const port = Bun.env.PORT ?? '3000'
  return { dbUrl, port }
}
```

In `server.config.ts`:

```typescript
import { defineConfig } from '@server/core'

export default defineConfig({
  port: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  // ...
})
```

---

## `.env.example` Template

```ini
# Example environment variables for Bakery
# Copy this to `.env` and fill with real values during deployment.

# Dashboard console password (if set, dashboard requires login)
DASHPASS=your_dashboard_password_here

# Optional: Database connection URLs
# DB_URL=sqlite://.server/database/bakery.db
# DB_URL=postgres://user:pass@localhost:5432/dbname
# DB_URL=mysql://user:pass@localhost:3306/dbname
```

---

*[← server.config.ts](./server-config.md) · [Import Maps & TSConfig Sync →](./import-maps.md)*

*[← Back to README](../../README.md)*
