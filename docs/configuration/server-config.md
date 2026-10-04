# `server.config.ts`

One file, at the root of your app, exporting one object. Bakery reads it once at
startup and freezes the result.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3000,
})
```

`defineConfig` is an identity function whose only job is to type its argument
against `AppConfig`: you get completion and an error on a typo instead of a
silently ignored key. It is exported from `@bakery-framework/core`.

## How it loads

`initConfig()` resolves `server.config.ts` against the **application's working
directory**, not against the framework
(`packages/core/src/core/config.ts`). Run the server from the app
directory, not from a monorepo root.

The file is optional. If it is missing, the server starts on the defaults below
(`packages/core/src/core/config.ts`). Defaults are a usable
configuration; the config file exists to change them, not to enable the server.

A file that is **present but fails to import** is treated differently from an
absent one (`config.ts`). In production the process refuses to start (the
throw lands in the entry's catch and the process exits 1), because booting on
port 3000 with no plugins and no hosts is not what a broken config asked for.
In development the server still boots on the defaults, but loudly: the import
error is logged immediately and restated in the startup banner, where you are
actually looking.

The merge is a shallow spread of your object over the defaults
(`config.ts`). There is no deep merge: if you set `websocket`, you replace
the whole handler object. Two keys are special-cased after the spread:
`importMap` is merged rather than replaced, and `blocked` is appended to the
built-in list.

The result is frozen and cached for the process lifetime. Nothing re-reads the
file; changing it requires a restart, including in dev.

## The full surface

Everything `AppConfig` accepts (`packages/core/src/global.d.ts`), with
the default from `packages/core/src/core/config.ts`.

| Option | Type | Default |
| --- | --- | --- |
| `root` | `string` | `'src'` |
| `port` | `number` | `3000` |
| `host` | `string` | `'0.0.0.0'` |
| `importMap` | `Record<string, string>` | `{ '@client/utils': '/_client/utils.js' }` |
| `head` | `string` | `''` |
| `body` | `string` | `''` |
| `proxy` | `Record<string, string>` | `{}` |
| `blocked` | `string[]` | `[]` (added to the built-in list) |
| `rateLimit` | `{ max, refill, keyBy?, routes? } \| false` | `{ max: 100, refill: 10 }` |
| `cors` | `CorsOptions \| null` | `null`. No header is ever written |
| `trustProxy` | `boolean` | `false` |
| `maxBodySize` | `number` | `20971520` (20 MiB) |
| `backups` | `number` | `10` |
| `schema` | `string` | `''` (auto-detect) |
| `middleware` | `((req, server) => Response \| void)[]` | `[]` |
| `plugins` | `ServerPlugin[]` | `[]` |
| `websocket` | `Bun.WebSocketHandler` | four no-ops |
| `onStart` | `() => void` | no-op |
| `onRequest` | `(req) => any` | no-op |
| `onError` | `(error) => any` | logs a warning |
| `onShutdown` | `() => void` | no-op |
| `hosts` | `Record<string, HostEntry>` | `{}` |

`maxCacheSize` used to be listed here. It was declared, defaulted to 500, and
read by nothing: the route LRUs size themselves and the tiered cache takes its
own options. It has been removed rather than wired up: there is no single cache
it plausibly governed, and a knob that typechecks while doing nothing is worse
than an absent one.

## Where files are served from

`root` is resolved against the working directory (`config.ts`) and becomes
`Bakery.serveRoot`. Routes, pages and API files are found under it:
`Bakery.apiRoot` is `<root>/api` (`packages/core/src/core/bakery.ts`).

`root` is one of the few options a host entry may override, which is how one
process serves two different site trees. See
[Multi-host](multi-host.md).

## Port and host

`port` is the listening port and `host` the bind address. The default
`'0.0.0.0'` binds every interface; use `'127.0.0.1'` to accept only local
connections.

The `PORT` environment variable **wins over `port`**
(`packages/cli/src/worker.ts`), which is what most container platforms
expect. See [Environment](environment.md).

## Rate limiting

Rate limiting is **on by default**. Every request passes through a token bucket
before any handler runs (`packages/cli/src/worker.ts`); over budget
returns `429 Too Many Requests`: the reason as a plain-text body, plus a
`Retry-After` header saying when the bucket holds a token again. Rejections are
logged at most once per key per 30 seconds, with a suppressed count, so a flood
cannot turn the limiter into a logging flood.

Because the default can surprise (it 429s load tests and busy shared-NAT
offices) the startup banner announces it whenever the default value is in
effect (`packages/core/src/startup.ts`). Configure any value of your own and
the line disappears.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  rateLimit: { max: 100, refill: 10 },
})
```

- `max`: bucket capacity, so the largest burst a single client can make.
- `refill`: tokens added per second, fractions included: `1 / 60` is one a
  minute. Sustained throughput settles here.
- `keyBy`, optional. Returns the string identifying the caller. Without it, or
  when it returns nothing, the key is the client IP (`utils/http/ip.ts`),
  falling back to the hostname.
- `routes`, optional. Budgets for parts of the site, in buckets of their own.
  See [Budgets per path](#budgets-per-path).

The default `{ max: 100, refill: 10 }` means a client may burst 100 requests,
then continues at 10 per second. Buckets live in a `SharedArrayBuffer` of 16384
slots indexed by a hash of the key
(`packages/core/src/utils/shared-pool.ts`), so the limit is shared across
cluster workers, and two different keys can land in one bucket: with a
thousand keys active, about 6% share one. It is a flood guard, not an exact
per-user quota.

Set `rateLimit: false` to turn it off. Do that only if something in front of the
process is already doing the job; a lone Bakery process with rate limiting off
has no flood protection at all.

### Assets do not count

A URL a handler has served as an asset stops counting: files from the serve
root and `/uploads/`, compiled `.ts` modules, bundled `/_nm/` packages, the
framework's `/_client/` files, and a Vue page's stylesheet, root script and
module scripts (those of components without a `<script server>` block). The
first request for a URL borrows a token and gets it back once the response
shows it was an asset. Later requests for that URL, from anyone on the same
host, skip the bucket. A page of forty modules costs one request, the page.

The handler that served the request decides, after the response, never the
request itself: a path that is not there answers 404 and keeps counting, and a
deleted file starts counting again the moment it fails. Image resizes and
Google Fonts keep counting, since each new size or family in a URL is new work.
A plugin's handler opts in with `static isAsset()` (see
[Plugin API](../plugins/plugin-api.md#handlers-are-the-real-extension-point)).

Each process remembers up to 5000 asset URLs (500 per cluster worker), by host,
path, query and `Sec-Fetch-Dest`; an evicted URL borrows a token on its next
request and is remembered again.

### Budgets per path

`routes` gives parts of the site buckets of their own. A request is charged to
the rule with the longest prefix that covers its path, and to that rule only;
a path no rule covers spends from the top level.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  rateLimit: {
    max: 300,
    refill: 30,
    // Signed in: a bucket per account, however many share one address.
    keyBy: req => req.session.get('accountId'),
    routes: [
      // Sign-in and password reset: 10 a minute per address.
      { prefix: '/api/auth', max: 10, refill: 1 / 6 },
    ],
  },
})
```

A prefix matches whole segments, ignoring case and empty segments, the way
routing reads a path: `/api/auth` covers `/api/auth/sign-in` and
`/API//auth/sign-in`, and not `/api/authors`. Both of those spellings reach the
sign-in route on Windows, where the filesystem ignores case, and `//` reaches it
everywhere, so a prefix compared as a plain string would let them through on the
top-level budget.

A rule's `keyBy` defaults to the client address, **not** to the top-level
`keyBy`: a rule usually guards something worth attacking, and an address cannot
be multiplied by opening more sessions. Give the rule a `keyBy` of its own to
key it another way.

A host's `rateLimit` (see [Multi-host](multi-host.md)) replaces the base one
whole, rules included.

A setting that cannot mean anything stops the server at boot, naming the field:
a `max` below 1, a `refill` of 0 or less, a prefix without its leading `/`, two
rules for one prefix.

### Keying on a header

`keyBy` receives the raw `Request`. If you key on a client-supplied header,
remember an attacker controls it:

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  trustProxy: true,
  rateLimit: {
    max: 60,
    refill: 5,
    keyBy: req => req.headers.get('x-api-key') || '',
  },
})
```

## `cors`

`null` by default, and absent means no `Access-Control-Allow-*` header is ever
written: the browser's own default. There is deliberately no permissive
development default.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  cors: {
    origin: ['https://app.example'],
    credentials: true,
    exposeHeaders: ['X-Total-Count'],
    maxAge: 600,
  },
})
```

Preflights are answered before routing; the headers are appended in the one
funnel every response passes through. `origin: '*'` combined with
`credentials: true` is refused rather than silently downgraded. Per-host entries
may carry their own `cors`. Full option table and the reasoning in
[CORS](../guides/cors.md).

## `trustProxy`

Off by default. Turning it on tells three separate pieces of code to believe
forwarding headers:

- the client IP comes from `cf-connecting-ip`, `x-forwarded-for`, `x-real-ip`
  and six others instead of the socket (`utils/http/ip.ts`);
- the hostname comes from `x-forwarded-host` instead of `Host`
  (`core/bakery.ts`);
- `x-forwarded-proto: https` marks the session cookie `Secure`
  (`packages/core/src/session.ts`).

Turn it on **only** when a proxy you control is the sole path to the process.
With it on and the port exposed directly, any client can forge its own IP,
hostname and scheme.

## Blocked paths

`blocked` is a list of glob patterns that are refused with `403` whenever the
handler about to answer serves files off disk: route-only handlers
(middleware, proxy, API) are exempt (`packages/core/src/router.ts`), and
checked again in the static fallback
(`handlers/assets/static.ts`). Patterns without a `**/` prefix get one, so
`'secrets/**'` becomes `'**/secrets/**'` (`config.ts`).

Your patterns are **added to**, never replace, the built-in list
(`packages/core/src/utils/constants.ts`):

```
**/.env             **/*.env            **/*.sql          **/*.db
**/package.json     **/package-lock.json
**/tsconfig.json    **/tsconfig.*.json
**/*.yaml           **/*.yml            **/*.lock         **/bun.lockb
**/.cache/**/*     **/bakery/**/*       **/_internal/**/*
**/.git/**/*        **/.vscode/**/*     **/node_modules/**/*
**/server.config.ts **/schema.ts        **/.gitignore     **/*.exe
```

There is deliberately no extension-wide ban on `.json`: it caught every JSON
document an app might legitimately publish, a web app manifest, a
`.well-known` file, and since `blocked` can only append, there was no way to
opt back out. The named project files above are what the list actually
protects. Matching also folds case and Win32 trailing dots/spaces, so
`/PACKAGE.JSON` and `/package.json.` are refused too
(`utils/constants.ts`).

## Proxy

`proxy` maps a path prefix to an upstream base URL. Longest-prefix wins is *not*
implemented: the first matching prefix in insertion order is used
(`handlers/routes/proxy.ts`).

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  proxy: {
    '/api/legacy': 'http://127.0.0.1:8080',
  },
})
```

`Cookie`, `Authorization`, `Host` and `Sec-Fetch-Site` are stripped before the
upstream request, and redirects are not followed
(`handlers/routes/proxy.ts`). An upstream that needs credentials will not
get the caller's.

## Import map

`importMap` adds entries to the browser import map injected into every HTML
page. Your entries are merged over the framework's, which always contains
`@client/utils` (`config.ts`).

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  importMap: {
    '@app/': '/lib/',
  },
})
```

Bare specifiers for your `package.json` dependencies are added automatically
from `node_modules`, mapped to `/_nm/<name>`
(`utils/http/dom.ts`): you do not list those yourself. In dev, the map
is also written into `tsconfig.json` paths so the editor agrees with the browser
(`packages/cli/src/dev.ts`).

## `head` and `body`

Raw markup appended to every HTML response: `head` just after the opening
`<head>`, `body` just before `</body>` (`utils/http/html.ts`,
`:88-99`). It is inserted verbatim and not escaped. Keep request data out of it.

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  head: '<link rel="stylesheet" href="/styles/global.css">',
})
```

The assembled strings are cached per hostname in a 64-entry LRU
(`utils/http/dom.ts`).

## Middleware and `onRequest`

Both run in the highest-priority fetch handler, before any route resolution
(`handlers/core/$middleware.ts`). `onRequest` runs first; if it returns anything
truthy that becomes the response. Then each `middleware` runs in order, and the
first one returning a `Response` wins. Returning nothing continues the chain.

```ts
import { defineConfig, response } from '@bakery-framework/core'

export default defineConfig({
  middleware: [
    req => {
      if (new URL(req.url).pathname.startsWith('/admin')) {
        if (!req.session.get('userId')) return response.href('/login', 302)
      }
    },
  ],
})
```

A middleware that **throws** produces `500` and the request stops there
(`$middleware.ts`). This is deliberate: middleware is usually an auth
check, and treating a thrown error as "no opinion" would let the request
through.

## Lifecycle hooks

- `onStart()`: after the server is listening and plugins have started
  (`packages/core/src/startup.ts`).
- `onError(error)`: every request error, with `{ errorCode, errorText,
  errorBody }`. Return a `Response` to replace the error page; return nothing to
  fall through to the error-handler registry (`router.ts`). The default
  logs a warning tagged with the hostname (`config.ts`).
- `onShutdown()`: runs **first** in the shutdown sequence, before the
  framework's own hooks flush the caches and close the databases
  (`packages/cli/src/shutdown.ts`). It goes first on purpose: it is the only
  participant that may still need the framework intact, so a last session write
  from here still lands. The whole sequence is bounded by a deadline, and each
  step is isolated: a throwing hook is logged and the rest still run.

`Bakery.onShutdown(fn)` also works, for a hook registered at runtime rather
than in config; those run second, as part of the framework step:

```ts
import { Bakery } from '@bakery-framework/core'

Bakery.onShutdown(async () => {
  // flush, close, drain
})
```

```ts
import { defineConfig, log } from '@bakery-framework/core'

export default defineConfig({
  onError(error) {
    log({ level: 'error', by: 'app', msg: `${error.errorCode} ${error.errorBody}` })
  },
})
```

## Database options

- `backups` (default `10`): how many database backups `db:sync` keeps before
  deleting the oldest (`packages/orm/src/backup.ts`).
- `schema` (default `''`): where the ORM finds your schema: a file, or a folder
  containing `index.ts`, relative to the app's cwd. Empty means auto-detect
  `orm/` then `schema.ts`. A configured path that does not exist is a hard
  error, not a fall back to auto-detect: a typo must not cause a fresh schema
  to be generated somewhere else (`global.d.ts`).

```ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  schema: 'db/orm',
  backups: 20,
})
```

The connection URL itself is **not** in this file; it comes from the
environment. See [Environment](environment.md).

## Body size

`maxBodySize` is passed straight to `Bun.serve` as `maxRequestBodySize`
(`packages/cli/src/worker.ts`). Bodies over the limit are rejected by Bun
before your code runs.

## Plugins and WebSocket

`plugins` takes the values returned by a plugin factory; each is set up during
`setupServer()`. `websocket` is a raw `Bun.WebSocketHandler` whose callbacks the
router invokes for connections that no `WebSocketHandler` claimed
(`router.ts`).

```ts
import { defineConfig } from '@bakery-framework/core'
import dashboardPlugin from '@bakery-framework/plugin-dashboard'

export default defineConfig({
  plugins: [dashboardPlugin({ authorize: req => req.session.get('role') === 'admin' })],
})
```

## Per-host overrides

`hosts` maps a hostname to a `HostEntry` that overrides a subset of the options
above for requests arriving on that name. It has its own page:
[Multi-host](multi-host.md).
