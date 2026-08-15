# CORS

Cross-origin resource sharing: what lets a browser page on `https://app.example`
read a response from `https://api.example`. Bakery ships the pieces of an API
server — `ApiHandler`, sessions, CSRF, rate limiting — and `cors` is what makes
one reachable from a browser somewhere else.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  cors: {
    origin: ['https://app.example'],
    credentials: true,
  },
})
```

## Nothing happens unless you configure it

There is **no default**, not even a permissive one in development. `cors` absent
means no `Access-Control-Allow-*` header is ever written, which is the browser's
own default and the safe one.

That is a deliberate refusal of the usual convenience. A framework that quietly
allows every origin in development teaches people it works, and then surprises
them the first time they deploy — or, worse, does not surprise them, because
they shipped the permissive setting.

## Where it runs

Two halves, in two places, because a preflight has no route to run and every
other response does
([packages/core/src/router.ts](../../packages/core/src/router.ts)):

1. **Preflight**, answered inside `handleRequest` **before routing** and before
   the forbidden-path check. The browser will not send the real request until
   this is answered, and there is no route to answer it.
2. **Headers**, appended in `processResponse` — the one funnel every response
   passes through, so a page, an API route, a static file, a proxied response
   and an error all get the same treatment.

A preflight is `OPTIONS` **carrying `Access-Control-Request-Method`**. A plain
`OPTIONS` is a normal request and falls through to routing, so an app with its
own `OPTIONS` route does not find it shadowed.

## Options

| Option | Type | Default |
| --- | --- | --- |
| `origin` | `string \| string[] \| (origin: string) => string \| null` | required |
| `methods` | `string[]` | `GET, HEAD, PUT, PATCH, POST, DELETE` |
| `allowHeaders` | `string[]` | echoes what the browser asks for |
| `exposeHeaders` | `string[]` | nothing is exposed |
| `credentials` | `boolean` | `false` |
| `maxAge` | `number` (seconds) | unset |

### `origin`

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  cors: { origin: ['https://app.example', 'https://admin.example'] },
})
```

A list is matched exactly and the matching origin is echoed back. A function
receives the request's `Origin` and returns the value to echo or `null` to deny,
which is how you do wildcard subdomains:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  cors: {
    origin: o => (o.endsWith('.example.com') ? o : null),
    credentials: true,
  },
})
```

Write that predicate carefully. `o.endsWith('example.com')` — without the dot —
also matches `https://notexample.com`, which is the classic way this goes wrong.

**`origin: '*'` with `credentials: true` is refused, not downgraded.** The pair
returns no headers at all, so the request is denied. The browser rejects that
combination anyway, so honouring it would produce a request that fails in the
client while the server believes it allowed the call; echoing the origin instead
would be a quiet *widening* of what you asked for. A visibly denied request is
the direction a security control should fail in.

### `credentials`

Sends `Access-Control-Allow-Credentials: true`, which is what lets the browser
attach cookies to a cross-origin request — and therefore what a cross-origin
session needs. It requires a specific `origin`, never `'*'`.

### `exposeHeaders`

Cross-origin JavaScript can read only a handful of response headers by default.
Anything of your own — a pagination cursor, a request id — has to be named here
or `res.headers.get()` returns `null` in the browser with no error.

### `maxAge`

How long the browser may cache the preflight, in seconds. Unset means it
preflights every request, which doubles the round trips on anything that is not
CORS-simple.

## Caching

`Vary: Origin` is set whenever the allowed origin is anything but `'*'`, because
the response now differs per origin and a shared cache that ignored it would
serve one origin's response to another. Preflights additionally vary on
`Access-Control-Request-Headers`.

If a response already carries a `Vary` from ETag negotiation, the value is
**appended** rather than replaced — whichever ran second does not drop the
other's.

## CORS is not the CSRF guard

These are different mechanisms solving different problems, and configuring one
does not affect the other.

- **The CSRF guard** rejects unsafe `/api/` methods whose `Origin` disagrees
  with the request URL, or whose `Sec-Fetch-Site` says cross-site. It has no
  configuration switch. See
  [API routes](api-routes.md#csrf-why-your-post-returns-403).
- **CORS** tells the browser whether it may *read* a response from another
  origin.

So configuring `cors` does not open your API to cross-origin `POST`s from a
browser session — the CSRF guard still refuses those. A cross-origin client
that needs to write should authenticate with something other than a cookie,
which is also what makes it safe.

## Notes

- **A denied preflight still answers 204**, just without the permitting headers.
  A 403 would report the same failure to the browser while inviting you to debug
  the route, which is not where the problem is.
- **Per-host CORS works.** `cors` is read from `Bakery.config`, so a `hosts`
  entry can carry its own. See [Multi-host](../configuration/multi-host.md).
- **The types are exported.** `import type { CorsOptions } from
  '@bakery-framework/core'` if you build the object somewhere other than inline.

## Next

- [API routes](api-routes.md) — the CSRF guard and what it does instead.
- [Security](../deployment/security.md) — what the framework does and does not do for you.
- [server.config.ts](../configuration/server-config.md) — every option.
</content>
