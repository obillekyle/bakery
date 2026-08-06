# Security

This page states what the framework actually does, so you neither assume
protection you do not have nor rebuild protection you already have.

Two failure modes are equally expensive. Believing Bakery has no rate limiting
leads to a redundant layer at the proxy and a real limit nobody knows how to
tune. Believing it validates your input leads to something worse.

## On by default

### Rate limiting

Every request passes a token bucket before any handler runs
(`packages/cli/src/worker.ts`). Over budget returns `429`.

Default: `{ max: 100, refill: 10 }` — burst 100, then 10 per second, keyed by
client IP. Buckets live in a shared 1024-slot buffer
(`packages/core/src/utils/shared-pool.ts`), so the budget is shared
across cluster workers and two clients can hash into the same slot. It is a
flood guard, not a per-user quota.

Configure it in `server.config.ts`; see
[Rate limiting](../configuration/server-config.md#rate-limiting).

### Blocked paths

A glob list is checked before routing and again in the static fallback
(`packages/core/src/router.ts`,
`packages/core/src/handlers/assets/static.ts`), returning `403`. The built-in
list (`packages/core/src/utils/constants.ts`) covers `.env`, `*.db`,
`*.sql`, `*.json`, `*.yaml`, `*.lock`, `.git/`, `node_modules/`, `.bakery/`,
`.data/`, `server.config.ts` and `schema.ts`. Your `blocked` entries are added
to it, never replace it.

Separately, static resolution refuses any path that escapes its root after
resolution, and honours a `.forbidden` marker file in any parent directory
(`packages/core/src/handlers/core/$static.ts`,
`packages/core/src/utils/fs.ts`).

### CSRF on API routes

`ApiHandler` rejects state-changing methods that look cross-site, with `403`
before your handler runs (`packages/core/src/handlers/routes/api.ts`).
`GET`, `HEAD` and `OPTIONS` pass through; everything else must have a
same-origin `Sec-Fetch-Site` or a matching `Origin`
(`packages/core/src/utils/http/csrf.ts`).

`SameSite=Lax` alone does not cover this — a cross-site form POST is a
CORS-simple request and arrives with the cookie attached. Details and the
`fetch` patterns that satisfy it are in
[API routes](../guides/api-routes.md).

Two scope limits: the check runs **only under `/api/`**, so a form POST to a
page route is not covered; and a request carrying neither `Origin` nor
`Sec-Fetch-Site` is allowed through, because browsers always send at least one
and `curl`/server-to-server callers send neither.

### Session cookies

`sId=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=…; Secure`
(`packages/core/src/session.ts`).

`Secure` is set over https, or with `trustProxy` and
`x-forwarded-proto: https`, or **whenever the process is in production** — so a
TLS terminator that forgets the header cannot downgrade the cookie. You do not
need middleware for this flag.

The id is 32 random bytes, not a UUID (`session.ts`). Expiry is checked on
read, so a stolen id stops working at the timeout rather than at the next sweep
(`session.ts`). See [Sessions](../guides/sessions.md).

Session keys beginning with `__bakery.` are reserved privilege markers; code
that writes caller-supplied keys must refuse the prefix with
`isReservedSessionKey` (`session.ts`).

### Proxying

`Cookie`, `Authorization`, `Host` and `Sec-Fetch-Site` are stripped before the
upstream request, and redirects are not followed — following one would re-attach
those headers to whatever host the upstream names, including link-local
addresses (`packages/core/src/handlers/routes/proxy.ts`).

### Output escaping

JSX escapes text children and attribute values by default
(`packages/core/src/core/jsx.ts`). Opt out only through the `html` helper, which
marks a string as already-safe. `head` and `body` from `server.config.ts` are
injected verbatim — keep request data out of them.

### SQL

Values bind as parameters. Identifiers go through exactly one writer —
`qId`/`qRef`/`qRaw` (`packages/orm/src/schema-util.ts`) — plus
`safeColumn`'s function allow-list for `orderBy`/`groupBy`
(`packages/orm/src/orm/query.ts`). String interpolation next to SQL is a
review flag in this codebase, not a style preference.

### Failing closed

Several places deliberately deny on an indeterminate answer, because that is
where security bugs hide:

- A middleware that throws produces `500`; the request does not continue
  (`packages/core/src/handlers/core/$middleware.ts`).
- An `authorize` predicate that throws is a denial
  (`packages/plugins/dashboard/src/authorize.ts`).
- With no `authorize` configured, the dashboard allows loopback in development
  and **nothing in production** (`authorize.ts`).
- Every dashboard write needs `DASHBOARD_ALLOW_WRITES=1` — the SQL console and
  the grid editor alike, including table truncate. `ATTACH`, `DETACH` and
  `VACUUM INTO` are refused outright
  (`packages/plugins/dashboard/src/endpoints/database.ts`).

### Request size

`maxBodySize` (20 MiB by default) is enforced by Bun before your code runs
(`packages/cli/src/worker.ts`).

## Not provided

Bakery does not do these. If you need them, they are yours to add.

- **TLS.** Terminate it in front of the process.
- **Authentication and identity.** There is no user model, no password
  handling, no login. The dashboard deliberately gave up having one so that it
  composes with yours.
- **CORS.** No `Access-Control-Allow-*` header is ever emitted. Cross-origin
  browser clients will not work until you add one in middleware.
- **Security headers.** No CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options`
  or `Referrer-Policy`. Nothing sets them.
- **Input validation.** Request bodies reach your handler as parsed data with no
  schema check.
- **Encryption at rest.** The SQLite database and the session store are plain
  files under `.data/`.
- **Origin checks on WebSocket upgrades.** The CSRF guard covers `/api/` fetch
  routes only; a WebSocket upgrade is not checked. `SameSite` does not apply to
  WebSocket handshakes either, so authenticate inside your `WebSocketHandler`
  and verify `Origin` there if the socket is privileged.
- **Per-route or per-user rate limits.** One global bucket, keyed by IP unless
  you supply `keyBy`.
- **Bot detection, CAPTCHA, account lockout, audit logging.**

## `trustProxy` is a security decision

Off by default. Turning it on makes three separate pieces of code believe
client-supplied headers:

| With `trustProxy: true` | Source | Consequence if forged |
| --- | --- | --- |
| Client IP | `cf-connecting-ip`, `x-forwarded-for`, and seven others (`packages/core/src/utils/http/ip.ts`) | Rate limit evaded; logs poisoned |
| Hostname | `x-forwarded-host` (`packages/core/src/core/bakery.ts`) | A different host's config is applied |
| Scheme | `x-forwarded-proto` (`packages/core/src/session.ts`) | Only affects the `Secure` flag, which production sets anyway |

Turn it on only when a proxy you control is the *sole* path to the process, and
bind `host: '127.0.0.1'` so that is actually true. With the port also reachable
directly, any client can forge all three.

Note the first column is not a single header: the IP is taken from whichever of
nine headers appears first in that fixed order. A proxy that forwards a client's
own `cf-connecting-ip` unmodified hands control of the rate-limit key to the
client.

## Adding what is missing

Security headers and CORS belong in middleware, which runs before routing:

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  middleware: [
    async (req, server) => {
      // Middleware returns a Response to stop the chain, or nothing to
      // continue — so headers on the *outgoing* response are set by wrapping
      // a preflight answer here and using a plugin or a proxy for the rest.
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': 'https://app.example.com',
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'content-type',
            'Vary': 'Origin',
          },
        })
      }
    },
  ],
})
```

Middleware sees the request, not the eventual response
(`packages/core/src/handlers/core/$middleware.ts`), so it can answer a
preflight but cannot decorate a response produced downstream. For headers on
every response, set them at the reverse proxy, or return them from the handlers
that need them.

An origin allow-list must be an allow-list. Reflecting `req.headers.get('origin')`
back with credentials enabled is the same as having no check.

## Checklist

- [ ] Dashboard plugin removed in production, or given a real `authorize`.
- [ ] `DASHBOARD_ALLOW_WRITES` unset.
- [ ] `trustProxy` matches the deployment, with `host` bound to loopback if it
      is on.
- [ ] Rate limit tuned rather than duplicated — or deliberately disabled with
      something else doing the job.
- [ ] Security headers and CORS added if you need them; nothing sets them for
      you.
- [ ] Request bodies validated in your handlers.
- [ ] `.data/` not web-reachable (it is blocked by default — do not remove that
      pattern) and not in a public volume.
- [ ] WebSocket handlers authenticate their own connections.
