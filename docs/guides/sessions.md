# Sessions

Every request has `req.session`. There is nothing to install and nothing to
configure.

```ts
export default function counter(req: Request) {
  const views = req.session.get('views', 0) + 1
  req.session.set('views', views, true)
  return `You have been here ${views} times.`
}
```

The cookie is issued for you on the way out. You never call `Set-Cookie`.

## What happens per request

`req.session` is a **deferred** property: it is defined on the request but the
`Session` object is not built until something reads it
(`packages/cli/src/worker.ts`). A request that never touches sessions costs
nothing.

On first read (`packages/core/src/session.ts`):

1. The `sId` cookie is parsed out of the `Cookie` header.
2. If it names a live, unexpired session, that one is returned and marked
   accessed — which slides expiry without counting as a write.
3. Otherwise a new empty `Session` is created.

On the way out, `processResponse` asks the session for a cookie
(`packages/core/src/router.ts`). It returns one **only if the session was
modified, or the cookie has crossed half its `Max-Age`** since it was last
issued (`session.ts`). Three consequences worth knowing:

- An anonymous visitor who never writes to the session gets no cookie and no
  stored state. No consent banner is needed for a cookie that is never set.
- Merely *reading* a session does not re-issue the cookie or write the store.
  It used to: every session-carrying response got a fresh `Set-Cookie`, which
  made each response unique and defeated `If-None-Match` caching, and every
  read dirtied the session into the next disk flush.
- Sliding expiry still works. A read re-stamps the in-memory access time, and
  once more than half the cookie's `Max-Age` has elapsed since it was last
  issued, the next response re-issues it *and* re-persists the session — so the
  stored row's access time renews at a cadence of at most half the timeout, and
  an active session never ages out on either side. `session.touch()` forces the
  refresh immediately.

The header is **appended**, not set, so a login route that issues its own cookie
keeps it (`router.ts`).

## The cookie

```
sId=<id>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<seconds>; Secure
```

Built at `packages/core/src/session.ts`.

- **`HttpOnly`** always. Script cannot read the session id.
- **`SameSite=Lax`** always. This stops a cross-site `fetch` or form POST from
  carrying the cookie, but *not* a top-level navigation — which is why API
  routes run a separate same-origin check. See
  [Security](../deployment/security.md).
- **`Secure`** when any of: the request URL is `https:`; `trustProxy` is on and
  `x-forwarded-proto` is `https`; or the process is in production
  (`import.meta.env.PROD`). The production case is deliberate — a TLS terminator
  that forgets to forward the header must not be able to downgrade the cookie.
  You do not need middleware to add this flag.
- **`Max-Age`** is 1 hour, or 30 days if the session has any persisted key
  (below).

The id is 32 bytes from `crypto.getRandomValues`, base64url-encoded
(`session.ts`). It is the sole bearer token, so it is not a UUID: UUIDv7
would leak a timestamp and carry only ~74 random bits.

## Expiry

Two idle timeouts, both measured from last access
(`packages/core/src/utils/constants.ts`):

| | Idle timeout |
| --- | --- |
| Ordinary session | **1 hour** |
| Session with at least one persisted key | **30 days** |

"Idle", not absolute: each request that touches the session restarts the clock —
reads included, without costing a write (see above).

Expiry is enforced twice. On read, an expired session is deleted and a fresh one
returned (`session.ts`) — so a stolen id stops working at the timeout,
not at the next sweep. A background sweep every 15 minutes then reclaims the
storage (`session.ts`).

## Persisted keys

By default a session is short-lived. Marking a key as persisted opts that
session into the 30-day window:

```ts
export default function login(req: Request) {
  req.session.set('userId', 'u_1024', true) // third argument persists
  req.session.persist('theme') // or mark an existing key
  return 'ok'
}
```

`persist(key, false)` removes the mark. `reset()` clears every non-persisted key
and keeps the rest; `reset(true)` clears the marks too and drops the session
entirely (`session.ts`).

Persistence also decides what survives a restart: the tiered cache writes an
entry to disk when it has persisted keys or any data at all
(`session.ts`).

## The API

```ts
import { Session } from '@bakery/core/session'

export default function demo(req: Request) {
  const session: Session = req.session

  session.set('cartId', 'c_1')       // write, marks modified
  session.get('cartId')              // string | undefined
  session.get('itemCount', 0)        // with a default
  session.delete('cartId')           // remove one key
  session.touch()                    // force a cookie refresh
  session.destroy()                  // drop it entirely

  return {
    id: session.id,
    createdAt: session.createdAt,
    accessedAt: session.accessedAt,
    persisted: session.persistedKeys,
  }
}
```

`session.data` is a proxy over the raw bag if you prefer property access; every
write through it marks the session modified (`session.ts`).

```ts
export default function viaProxy(req: Request) {
  req.session.data.lastPath = new URL(req.url).pathname
  return 'ok'
}
```

Statics for administration (`session.ts`): `Session.count`,
`Session.get(id)`, `Session.delete(id)`, `Session.keys()`, `Session.values()`,
`Session.entries()`, `Session.list({ page, pageSize, sortBy, sortOrder })`, and
an async iterator over every live session. All of them except `Session.count`
are scoped to the current host — see below.

## Rotate the id at the privilege boundary

`reset()` clears the data but keeps the id. On login that is not enough: the
visitor finishes authentication holding the id they arrived with, and if an
attacker planted that id they are now sharing the account. `regenerate()` mints
a fresh id, carries the data and persisted keys across, drops the entry under
the old id, and marks the session modified so the response re-issues the cookie
(`session.ts`).

```ts
export default function login(req: Request) {
  req.session.regenerate().set('userId', 'u_1024', true)
  return 'ok'
}
```

Call it on any privilege change — login, and again on logout if the session
outlives it. `createdAt` is preserved: the session continues, only its bearer
token changes.

## Sessions under multiple hosts

Session cache keys are namespaced by the current host through `hostKey()`
(`core/bakery.ts`), so a `hosts` entry is a tenant boundary: an id issued by
`a.com` does not resolve on `b.com`, and `Session.list()` — the dashboard's
session table — only shows the host it was asked on. A hostname with no `hosts`
entry, and every request in a single-host app, shares the default namespace.

Upgrading an app that already has `hosts` configured invalidates the sessions
stored under the old flat keys: everyone signs in once more, and the orphaned
rows fall out at the next prune.

## Typing the session

`SessionData` is a global interface declared by core
(`packages/core/src/global.d.ts`). Augment it in your app and `get`/`set`
become typed:

```ts
declare global {
  interface SessionData {
    cartId?: string
    lastPath?: string
  }
}

export function readCart(req: Request): string | undefined {
  return req.session.get('cartId')
}
```

It extends an index signature, so unknown keys still work — augmenting adds
completion and type checking for the keys you declare without making the rest an
error.

## Reserved keys

Keys beginning with `__bakery.` are framework-internal privilege markers
(`session.ts`). Application data shares the same bag, so **any code that
writes a caller-supplied key must refuse the prefix** — otherwise a preferences
endpoint becomes a privilege-escalation primitive:

```ts
import { isReservedSessionKey } from '@bakery/core/session'

export default function setPreference(req: Request, body: { key: string; value: string }) {
  if (isReservedSessionKey(body.key)) return 'forbidden'
  req.session.set(body.key, body.value)
  return 'ok'
}
```

The dashboard's own session editor does exactly this check
(`packages/plugins/dashboard/src/endpoints/sessions.ts`).

## Where sessions are stored

A two-tier cache (`packages/core/src/cache/tiered.ts`): a `Map` in memory, and a
`sessions` table in a SQLite file at **`bakery/shared-cache.db`**
(`packages/core/src/cache/shared-db.ts`). Reads hit memory first and fall back
to the table, promoting the row back into memory.

- Memory holds up to 1000 sessions, divided by four in cluster workers
  (`session.ts`, `tiered.ts`).
- Dirty entries flush to disk every **30 seconds** (`session.ts`).
- Shutdown hooks flush everything on `SIGINT`/`SIGTERM`
  (`tiered.ts`, `packages/cli/src/worker.ts`).

Two things follow.

**`bakery/` is not disposable.** Deleting it logs everyone out, and it is the
same directory as the database. See
[Production](../deployment/production.md).

**In a cluster, session writes are not instantly shared.** Each `--threads`
worker keeps its own memory tier and flushes on its own 30-second timer, so a
write on worker A may be invisible to worker B for up to that long, and B will
keep serving its cached copy if it already has one. For a login flag this is
usually fine; for a value read immediately after being written by a different
request, it is not. Use sticky sessions at the proxy, or keep that value in the
database.

## Sessions outside a request

`Session.bind(req, res)` and `session.bind(res)` attach the cookie manually
(`session.ts`, `:272-274`). You need this only when you construct a
`Response` outside the normal pipeline; ordinary handlers get the cookie from
`processResponse` automatically.
