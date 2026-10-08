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

1. The `sId` cookie is parsed out of the `Cookie` header and its signature
   checked. A cookie whose signature does not match names no session, and no
   store is asked about it (see [The cookie](#the-cookie)).
2. If it names a live, unexpired session, that one is returned and marked
   accessed, which slides expiry without counting as a write.
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
  issued, the next response re-issues it *and* re-persists the session, so the
  stored row's access time renews at a cadence of at most half the timeout, and
  an active session never ages out on either side. `session.touch()` forces the
  refresh immediately.

The header is **appended**, not set, so a login route that issues its own cookie
keeps it (`router.ts`).

## The cookie

```
sId=<id>.<mac>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<seconds>; Secure
```

Built at `packages/core/src/session.ts`.

- **Signed.** `<mac>` is an HMAC-SHA256 of the id, 128 bits of it, keyed by
  `sessions.secret` when it is set and otherwise by a key made once and kept
  in `bakery/session.key` (`session-signing.ts`). A cookie whose MAC does not
  match names no session and costs no lookup: refusing one takes about 3.6 µs,
  where the database store's lookup takes 0.37 ms (below). Servers that share
  one store need the same `sessions.secret`, and changing the secret ends
  every session, since no cookie verifies any more. The stored id has no MAC
  in it, so no store row changes.

- **`HttpOnly`** always. Script cannot read the session id.
- **`SameSite=Lax`** always. This stops a cross-site `fetch` or form POST from
  carrying the cookie, but *not* a top-level navigation, which is why API
  routes run a separate same-origin check. See
  [Security](../deployment/security.md).
- **`Secure`** when any of: the request URL is `https:`; `trustProxy` is on and
  `x-forwarded-proto` is `https`; or the process is in production
  (`import.meta.env.PROD`). The production case is deliberate: a TLS terminator
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

"Idle", not absolute: each request that touches the session restarts the clock.
Reads included, without costing a write (see above).

Expiry is enforced twice. On read, an expired session is deleted and a fresh one
returned (`session.ts`), so a stolen id stops working at the timeout,
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
import { Session } from '@bakery-framework/core/session'

export default function demo(req: Request) {
  const session: Session = req.session

  session.set('cartId', 'c_1')       // write, marks modified
  session.get('cartId')              // string | undefined
  session.get('itemCount', 0)        // with a default
  session.delete('cartId')           // remove one key
  session.touch()                    // force a cookie refresh
  session.destroy()                  // end it; a write after starts a new one

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
are scoped to the current host. See below. Their async forms,
`Session.total()`, `Session.end(id)`, `Session.page(options)` and
`Session.save(session)`, work with any store; the synchronous ones read the
built-in store (see [Sessions in the database](#sessions-in-the-database)).

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

Call it on any privilege change: login, and again on logout if the session
outlives it. `createdAt` is preserved: the session continues, only its bearer
token changes.

## Signing out

`destroy()` ends the session and leaves a new, empty one in its place, under a
fresh id. A request that stops there stores nothing and issues no cookie, so
the id the visitor still holds names nothing. One that goes on writing starts
an anonymous session of its own, which the response issues as usual:

```ts
export default function logout(req: Request) {
  req.session.destroy()
  req.session.set('flash', 'Signed out')
  return 'ok'
}
```

Up to 2.1.2 the object kept its id and its data after a destroy, and the
response stored it again whenever it had a reason to: a write after the
destroy (the flash message above), or a cookie past half its `Max-Age`, which
is due a refresh. Either one left the visitor signed in.

## Sessions under multiple hosts

Session cache keys are namespaced by the current host through `hostKey()`
(`core/bakery.ts`), so a `hosts` entry is a tenant boundary: an id issued by
`a.com` does not resolve on `b.com`, and `Session.list()` (the dashboard's
session table) only shows the host it was asked on. A hostname with no `hosts`
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

It extends an index signature, so unknown keys still work: augmenting adds
completion and type checking for the keys you declare without making the rest an
error.

## Reserved keys

Keys beginning with `__bakery.` are framework-internal privilege markers
(`session.ts`). Application data shares the same bag, so **any code that
writes a caller-supplied key must refuse the prefix**: otherwise a preferences
endpoint becomes a privilege-escalation primitive:

```ts
import { isReservedSessionKey } from '@bakery-framework/core/session'

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
`sessions` table in a SQLite file at **`bakery/sessions.db`**
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

That is also why the file lives there rather than under `.cache/`, which the
framework empties on every version change. It used to, and a framework patch
therefore logged out every user of every app. `sessions.db` now carries its own
schema version: a change to the stored *format* still drops sessions, a release
no longer does (`packages/core/src/cache/shared-db.ts`).

**In a cluster, session writes are not instantly shared.** Each `--threads`
worker keeps its own memory tier and flushes on its own 30-second timer, so a
write on worker A may be invisible to worker B for up to that long, and B will
keep serving its cached copy if it already has one. For a login flag this is
usually fine; for a value read immediately after being written by a different
request, it is not. Use sticky sessions at the proxy, or keep the sessions
themselves in the database (below).

## Sessions in the database

The built-in store keeps each worker's sessions in that worker's memory. Under
`--threads`, a session ended in one worker lives on in another until its copy
ages out, and a write in one may be invisible to another for half a minute.
`databaseSessions()` from `@bakery-framework/orm/sessions` keeps them in the
app's database instead, where every worker reads the same rows and nothing
keeps a copy between requests:

```ts
import { defineConfig } from '@bakery-framework/core'
import { databaseSessions } from '@bakery-framework/orm/sessions'

export default defineConfig({
  sessions: { store: databaseSessions(), account: 'accountId' },
})
```

`account` names the session key that holds the account id. The store copies
that value into an indexed column, which is how `Session.endForAccount()`
finds every session of one account with a single `DELETE`.

The table is the app's to create: the store never creates or alters one, which
a database role without DDL rights could not do and migrations mode would not
want done behind its back. One definition serves Postgres, MySQL and SQLite,
and in migrations mode it goes in a migration file:

```sql
CREATE TABLE bakery_sessions (
  id VARCHAR(64) NOT NULL PRIMARY KEY,
  host VARCHAR(255) NOT NULL DEFAULT '',
  account VARCHAR(255),
  data TEXT NOT NULL,
  persisted INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  accessed_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX bakery_sessions_account ON bakery_sessions (account, host);
CREATE INDEX bakery_sessions_expires ON bakery_sessions (expires_at);
```

Times are epoch milliseconds. `data` holds the session as JSON and stays
`TEXT`, because the dashboard's session search reads it as text. A different
name goes in both places: the SQL, and `databaseSessions({ table: 'sessions' })`.

Classic `db:sync` plans a drop for any table the schema leaves out, so an app
there declares the table instead, and the sync creates it:

```ts
import { Field } from '@bakery-framework/orm'

export namespace DBInfo {
  export const constraints = {
    bakerySessions: {
      id: Field.Varchar(64),
      host: Field.Varchar(255, ''),
      account: Field.Varchar(255, null),
      data: Field.Text(),
      persisted: Field.Int(),
      createdAt: Field.BigInt(),
      accessedAt: Field.BigInt(),
      expiresAt: Field.BigInt(),
    },
  } as const

  export const indexes = {
    bakerySessionsId: Field.Unique('bakerySessions', ['id']),
    bakerySessionsAccount: Field.Index('bakerySessions', ['account', 'host']),
    bakerySessionsExpires: Field.Index('bakerySessions', ['expiresAt']),
  } as const
}
```

Both are held to the store by `packages/orm/src/sessions.test.ts`, which runs
the SQL above as written on all three databases.

### Ending every session of an account

```ts
import { Session } from '@bakery-framework/core/session'
import DB from '@bakery-framework/orm'

export async function removeAccount(id: number): Promise<void> {
  await DB.transaction(async () => {
    await DB.Delete.from('accounts').where('accounts.id', id).run()
    await Session.endForAccount(id)
  })
}
```

Inside `DB.transaction()` the store runs on the transaction's connection, so
the account and its sessions go in one commit, or neither goes. The next
request carrying any of those cookies, in any worker, finds no session. The
account is matched as text, so `7` and `'7'` are one account, and without
`sessions.account` the call throws rather than ending nothing.

A request that had already read one of those sessions finishes with what it
read, and writes nothing back: a write to a session that is no longer stored
finds no row, stores nothing, and the response carries no cookie.

### A version that ends sessions

An app that keeps a version beside the account id ends sessions by moving the
version (a password change, a role taken away) and comparing it on every
request:

```ts
import DB from '@bakery-framework/orm'

export async function currentAccount(req: Request) {
  const id = req.session.get<number>('accountId')
  if (!id) return null
  const account = await DB.from('accounts').where('accounts.id', id).first()
  if (!account || account.version !== req.session.get('version')) {
    req.session.destroy()
    return null
  }
  return account
}
```

With the database store this holds in every worker the moment the version
moves, since no worker keeps a copy of the session that could be stale.

### What it costs

A request carrying a session cookie that verifies waits for one lookup by
primary key before anything else runs, which is what lets the rate limiter's
`keyBy` and every handler read `req.session` without awaiting it. One that
does not verify costs no lookup, so a flood of made-up ids from one address
never reaches the database before the limiter refuses it. Measured against Postgres 16
on loopback through the store itself, two adjacent runs with 2,000 sessions in
the table: 0.37 ms a lookup, against 0.28 to 0.30 ms for `SELECT 1` on the
same connection, so about 0.08 ms beyond the round trip. A renewal, an
`UPDATE`, took 0.70 ms. A request without the cookie costs nothing.

Writes happen when the built-in store would write: on a change, and when a
cookie passes half its `Max-Age`, which renews the times without rewriting
the data. Each write is awaited before the response leaves, so a login
answered with a redirect finds its session on the next request, whichever
worker takes it. Every worker deletes expired rows once a quarter hour, over
the `expires_at` index; a read ignores them before that.

Two differences from the built-in store follow from keeping no copy. Two
requests writing one session at the same moment each write their own copy,
and the later write wins, where the built-in store hands both requests one
shared object. And idle expiry counts from the last write rather than the
last read: a session read at least once in every half of its timeout never
expires, and one left alone ends between half its timeout and all of it after
its last request. A session written at sign-in and only read after, an
account id and a version, is unaffected by the first.

A store that cannot be read answers the request as a server error, rather
than as a visitor with no session.

### The statics with a configured store

`Session.total()`, `Session.end(id)`, `Session.endForAccount(id)`,
`Session.page(options)`, `Session.get(id)` and `Session.save(session)` work
with any store, and the dashboard and analytics plugins use them.
`Session.count`, `delete`, `list`, `keys`, `values`, `entries`, `create`,
`getCookie` and `bind` read the built-in store synchronously, and throw when a
configured store replaces it, naming what to use instead.

## Sessions outside a request

`Session.bind(req, res)` attaches the cookie manually. You need it only when
you construct a `Response` outside the normal pipeline; ordinary handlers get
the cookie from `processResponse` automatically.

It takes the request rather than the session because the cookie is read
through a symbol the router installs on the request. An instance form,
`session.bind(res)`, was documented here until 2.0 and never worked: it
constructed a stand-in object carrying no such symbol, so the lookup failed
and the cookie was silently not appended. Use the static form.

With a configured store, `bind` throws, since the store's write cannot finish
synchronously. `await Session.commit(req)` makes the write and returns the
cookie to append, `''` when there is none.
