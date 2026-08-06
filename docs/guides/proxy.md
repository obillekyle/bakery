# Proxy

`config.proxy` maps a URL prefix onto an upstream base URL. `ProxyHandler` sits
at priority 95 in the `fetch` registry, second only to middleware
(`packages/core/src/startup.ts`).

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  root: 'src',
  proxy: {
    '/api/v1': 'https://upstream.example.com',
    '/search': 'https://search.internal:9200/',
  },
})
```

`/api/v1/users?q=x` is forwarded to `https://upstream.example.com/users?q=x`. The
prefix is stripped, the remainder and the query string are appended, and a
trailing slash on either side is normalised away
(`packages/core/src/handlers/routes/proxy.ts`).

## Credentials are stripped, on purpose

Before forwarding, four request headers are **deleted**
(`handlers/routes/proxy.ts`):

```
cookie
authorization
host
sec-fetch-site
```

This is the single most important thing to know about the proxy, and it is the
opposite of what most reverse proxies do.

- `cookie` and `authorization` are dropped so that a third-party upstream never
  receives the caller's credentials. If someone proxies `/gh` to `api.github.com`
  and a user's session cookie for your domain rode along, that cookie has just
  been handed to GitHub.
- `host` is dropped so `fetch` derives it from the target URL. Leaving it would
  send your hostname to the upstream, which usually produces a vhost mismatch.
- `sec-fetch-site` is dropped because it describes the browser's relationship to
  *your* origin and is meaningless — or actively misleading — to the upstream.

**Consequence: an upstream that expects a bearer token or a session cookie will
return 401, every time.** That is a correct outcome, not a bug, and it is why the
proxy is only useful for endpoints that are either public or authenticated by
something else.

Every other header passes through untouched, so a custom header set by the client
(`X-Api-Key`, `X-Tenant`) does survive. There is no configuration to re-enable
the four that are removed, and there is no hook for adding headers to the
outbound request — if you need a server-held credential attached, write an API
route that does the `fetch` itself.

## It outranks almost everything

At 95, `ProxyHandler.canHandle` is asked before the API, page and asset handlers.
It returns true for *any* path starting with a configured prefix
(`proxy.ts`), which means a proxy entry shadows everything beneath it:

- `proxy: { '/api': ... }` disables all of your own `/api/` routes.
- `proxy: { '/': ... }` proxies the entire site, including `/_client/utils.js`.

Only middleware (100) runs first. Choose prefixes that cannot collide with
something you own.

## First match wins, not longest match

The prefixes are iterated in object insertion order and the loop `break`s on the
first `startsWith` hit (`proxy.ts`). It is not longest-prefix routing.

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  proxy: {
    // Wrong: '/api' matches first, so '/api/v2' is never reached.
    '/api': 'https://v1.example.com',
    '/api/v2': 'https://v2.example.com',
  },
})
```

Declare the more specific prefix first. Nothing warns you.

## Redirects are not followed

The upstream fetch uses `redirect: 'manual'` (`proxy.ts`), so a 3xx is passed
back to the browser with the upstream's `Location` header intact.

This is deliberate: following a redirect automatically would re-send the request —
and its remaining headers — to whatever host the upstream names, including a
link-local address. Manual redirects mean the browser makes that decision under
its own rules.

The practical consequence is that a **relative** `Location` from the upstream is
resolved by the browser against *your* origin, not the upstream's. An upstream
that redirects `/login` → `/auth/login` will send the browser to
`https://yoursite/auth/login`, which is probably not a route you have.

## Response rewriting

Two response headers are removed before the response is returned
(`proxy.ts`):

- `content-encoding` — Bun already decompressed the body, so the upstream's value
  is now a lie and the browser would try to decompress plain text.
- `content-length` — it described the *compressed* size.

Status, status text and every other header (including `Set-Cookie` from the
upstream) are passed through unchanged.

## Failures

Any thrown error from the fetch — DNS failure, connection refused, TLS error —
becomes `502 Bad Gateway` (`proxy.ts`). The upstream's own error statuses
are passed through as-is; a 500 from upstream reaches the client as a 500.

There is **no timeout**. A hanging upstream holds the request open for as long as
Bun's default `fetch` behaviour allows. If that matters, put the call in an API
route with an `AbortSignal` instead of using `config.proxy`.

Bodies are dropped for `GET` and `HEAD` (`proxy.ts`); every other method
streams the original request body through.

Each forwarded request is logged as `PROXY_REQ` with the path and the resolved
target (`proxy.ts`), so the log tells you exactly what URL was constructed.

## Per-host proxies

A `hosts` entry replaces the proxy map for that hostname rather than merging with
the global one (`packages/core/src/core/config.ts`):

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  root: 'src',
  proxy: { '/api/v1': 'https://public.example.com' },
  hosts: {
    'internal.example.com': {
      // The global '/api/v1' entry does NOT apply here.
      proxy: { '/api/v1': 'https://internal.example.com' },
    },
  },
})
```

## When not to use it

`config.proxy` is a development convenience and a way to put a public upstream
behind your origin. It is not a reverse proxy: no retries, no timeouts, no health
checks, no path rewriting beyond the prefix strip, no header injection, no
connection pooling beyond what `fetch` gives you.

Terminate TLS and route traffic with something built for it, and use
`config.proxy` for the case it handles well — one prefix, one upstream, no
credentials.
