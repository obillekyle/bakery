# Session System

Bakery includes a production-ready session system with a tiered memory/SQLite storage backend, configurable per-key persistence, and automatic pruning.

---

## Overview

Sessions are cookie-based and stored in a `TieredCache` (in-memory LRU + SQLite). A session is created lazily on first access and its cookie is set in the response only when the session data is modified.

- **Default TTL (non-persisted):** 24 hours from last access
- **Default TTL (persisted keys):** 30 days from last access
- **Prune interval:** Every 15 minutes
- **Cookie name:** `sId`
- **Cookie flags:** `HttpOnly; SameSite=Lax`

---

## Accessing the Session

The session is available as a property on every `Request` object:

```typescript
// In any API handler or TSX file
export default function(req: Request) {
  const session = req.session  // Session<SessionData>
  // ...
}
```

Or via the static `Session.from()` method:

```typescript
import { Session } from '@server/core/session'

export default function(req: Request) {
  const session = Session.from(req)
  // ...
}
```

Both are equivalent. `req.session` is lazily initialized and cached on the request object.

---

## Reading and Writing Data

```typescript
const session = req.session

// Write
session.set('username', 'alice')
session.set('theme', 'dark')

// Read
const username = session.get('username')           // → 'alice' | undefined
const theme = session.get('theme', 'light')        // → 'dark' (with default)

// Delete a key
session.delete('theme')

// Check for data
session.hasData()     // → true if any data stored
```

Session data is tracked by a `Proxy`. Any `set` or `delete` operation marks the session as "modified", which triggers cookie updates in the response.

---

## Persistence

By default, session data is ephemeral — it is stored in memory and backed up to SQLite, but it expires after 24 hours of inactivity.

To make specific keys survive across browser restarts (30 days), mark them as **persistent**:

```typescript
// Persist a key when setting it
session.set('userId', 42, true)  // third arg: persist = true

// Or persist an existing key explicitly
session.persist('userId', true)

// Stop persisting a key
session.persist('userId', false)
```

Persisted keys cause the `Set-Cookie` header to include a `Max-Age` of 30 days, making the cookie survive browser restarts. Non-persisted sessions get a session-scoped cookie (expires when browser closes).

---

## Session Lifecycle

```typescript
// Create a new session (happens automatically on first req.session access)
const session = Session.from(req)

// Get session ID
session.id        // UUIDv7 string

// Check when session was created
session.createdAt // Unix timestamp (ms)

// Check when session was last accessed
session.accessedAt // Unix timestamp (ms)

// Check if session is expired
session.isExpired() // → boolean

// Reset session data (preserves persisted keys by default)
session.reset()

// Full reset: clears persisted keys too
session.reset(true)

// Destroy the session entirely
session.destroy()
// or
Session.delete(req)
```

---

## Typed Sessions

Declare your session data shape in `global.d.ts` or any `.d.ts` file:

```typescript
// types.d.ts
declare global {
  interface SessionData {
    userId: number
    username: string
    role: 'admin' | 'user' | 'guest'
    theme: 'light' | 'dark'
    cart: number[]  // array of product IDs
  }
}
```

Now `req.session` is fully typed:

```typescript
const session = req.session  // Session<SessionData>

session.set('userId', 42)          // ✅ type-safe
session.set('username', 'alice')   // ✅
session.set('unknown', 'value')    // ⚠️ TypeScript warning (not in SessionData)

const userId = session.get('userId')   // → number | undefined
```

---

## Session Cookie Details

| Property | Value |
|----------|-------|
| Cookie name | `sId` |
| Path | `/` |
| HttpOnly | Yes |
| SameSite | `Lax` |
| Max-Age | 30 days (if persisted keys exist), session-only otherwise |
| Secure | Not set by default — add in production via middleware |

To add the `Secure` flag in production, wrap responses in middleware:

```typescript
// In server.config.ts middleware
middleware: [
  (req) => {
    // Handled at response level — use a plugin instead
  }
]
```

Or modify the session cookie in a plugin's `onRequest` by post-processing the response.

---

## Server-Side Session Management

```typescript
import { Session } from '@server/core/session'

// Get the total number of active sessions
const count = Session.count

// Iterate over all sessions
for await (const session of Session) {
  console.log(session.id, session.toJSON())
}

// Fetch a specific session by ID
const session = await Session.get('some-session-id')

// List sessions with pagination, search, and sort
const result = Session.list({
  search: 'alice',
  page: 1,
  pageSize: 20,
  sortBy: 'accessed',  // 'id' | 'keys' | 'created' | 'accessed'
  sortOrder: 'DESC',
})
// result.rows, result.totalRows, result.totalPages, result.page
```

---

## Session Storage Architecture

Sessions are stored in a `TieredCache<string, Session>` with:

- **In-memory threshold:** 1,000 sessions
- **SQLite flush interval:** Every 30 seconds
- **Persistence filter:** Only sessions with persisted keys or non-empty data are written to SQLite

When the memory threshold is exceeded, the oldest 10% of in-memory entries are evicted to SQLite. They are re-hydrated on next access.

The SQLite file for sessions is stored at `.server/.cache/sessions.json` (actually a SQLite DB, despite the name in constants).

---

*[← Dev Mode](../development/dev-mode.md) · [Database Overview →](../database/overview.md)*

*[← Back to README](../../README.md)*
