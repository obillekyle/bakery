# Multi-host

One process can serve several hostnames with different roots, middleware, proxy
tables and rate limits. Add a `hosts` map to `server.config.ts`:

```ts
import { defineConfig } from '@bakery/core'

export default defineConfig({
  root: 'src',
  port: 3000,
  hosts: {
    'example.localhost': {
      root: 'src/example',
    },
  },
})
```

Requests whose hostname is `example.localhost` are served from `src/example`.
Everything else keeps `src`. No second process, no second port.

## How the hostname is decided

`getHostname()` runs once per request, before any handler
(`packages/core/src/core/bakery.ts`):

1. With `trustProxy: true`, the first value of `x-forwarded-host`.
2. Otherwise the `Host` header.
3. Otherwise the hostname parsed out of the request URL.

The port is stripped in every case, so `example.localhost:3000` matches the key
`'example.localhost'`.

Two things follow from this. First, without `trustProxy` the `Host` header is
used as sent — behind a reverse proxy that rewrites `Host`, you will match the
wrong entry unless you turn `trustProxy` on and forward `X-Forwarded-Host`.
Second, the hostname is attacker-controlled input. Treat host selection as
routing, never as authorization.

## Matching

Lookup is an exact match against the keys of `hosts`, case-insensitively: both
the incoming hostname and your keys are folded to lower case, so `EXAMPLE.com`
finds an `example.com` entry. There are no wildcards and no suffix matching.
Write keys in lowercase anyway — it is the form browsers send, and if two keys
differ only in case the first declared wins.

A hostname with no entry gets the base config unchanged. The lookup goes through
a `Map` built from `Object.entries`, so it sees own enumerable keys only: a
request with `Host: constructor` cannot reach a prototype member and have it
merged as if it were a host entry.

Resolved host configs are cached, but **only for hostnames that matched**
(`config.ts`). Unknown hostnames are recomputed every time rather than
cached, because the value comes from a request header and caching misses would
let any client grow that map until the process ran out of memory.

## What a host entry may override

`HostEntry` is a strict subset of `AppConfig`
(`packages/core/src/global.d.ts`):

| Field | Merge behaviour (`config.ts`) |
| --- | --- |
| `root` | Replaces, resolved against cwd |
| `importMap` | **Merged** over the base import map |
| `middleware` | Replaces the whole array |
| `onRequest` | Replaces |
| `onError` | Replaces |
| `head` | Replaces if defined — including `''`, which clears it |
| `body` | Replaces if defined — including `''`, which clears it |
| `proxy` | Replaces the whole table |
| `blocked` | Rebuilt from the built-in globs **plus this entry** — the top-level `blocked` does not apply |
| `rateLimit` | Replaces, and `false` disables the limit for this host |

Anything not in that table is process-wide and cannot vary by host: `port`,
`host`, `plugins`, `websocket`, `maxBodySize`, `backups`, `schema`,
`trustProxy`, `onStart`, `onShutdown`.

The `blocked` row is the one that surprises people. A host entry's `blocked` is
concatenated with the framework defaults only — your top-level `blocked` list is
not included. If a pattern must apply everywhere, repeat it in each entry.

## Reading the active config

Host config is **ambient**, not passed. Before running any handler the worker
resolves the entry and enters an `AsyncLocalStorage` scope for the request
(`packages/cli/src/worker.ts`), and `Bakery.config` is a getter that reads
that store, falling back to the process config
(`packages/core/src/core/bakery.ts`):

```ts
import { Bakery } from '@bakery/core'

export function currentRoot(): string {
  return Bakery.config.root
}
```

Called during a request, that returns the current host's root. Called at module
load, it returns the process default. Nothing in your code needs to thread a
config object through; it also means anything that caches a config-derived value
at module scope will pin one host's value for every host.

Which is what `hostKey()` is for (`core/bakery.ts`). It prefixes a string
with the current hostname, so a cache keyed by path stays correct across hosts:

```ts
import { hostKey } from '@bakery/core/core/bakery'

const key = hostKey('/styles/app.css')
```

Only a hostname that appears in `hosts` gets its own prefix; anything else —
and every request in an app with no `hosts` at all — returns the path unchanged.
That is deliberate and it matters, because these keys become **filenames**: an
unconfigured host is served the base config, so it shares the base config's
cache entries rather than minting a new set. Without the allow-list, a client
sending 25 invented `Host` headers writes 25 new cache entries. Matching is
case-insensitive, so `EXAMPLE.com` and `example.com` are one key.

The static file cache already does this (`handlers/assets/static.ts`), as do
sessions (`session.ts`). If you write a per-request cache of your own, key it
the same way.

## Per-host import maps

Import maps are built once at boot, not per request. `initHostImportMaps()`
walks `hosts` and precomputes a map for every entry that declares one
(`packages/core/src/utils/http/dom.ts`); at render time the injected map
is the host's, or the default when the host has none
(`dom.ts`). A host that omits `importMap` shares the base map — it is
not given an empty one.

`head` and `body` are assembled per hostname and cached in a 64-entry LRU
(`dom.ts`, `utils/http/html.ts`). The bound is there because the key
comes from a request header.

## A fuller example

```ts
import { defineConfig, response } from '@bakery/core'

export default defineConfig({
  root: 'src',
  port: 3000,
  trustProxy: true,
  rateLimit: { max: 100, refill: 10 },

  hosts: {
    'app.example.com': {
      root: 'src/app',
      head: '<link rel="stylesheet" href="/styles/app.css">',
      middleware: [
        req => {
          if (!req.session.get('userId')) return response.href('/login', 302)
        },
      ],
    },

    'api.example.com': {
      root: 'src/api-site',
      // Stricter budget for the API surface.
      rateLimit: { max: 30, refill: 3 },
      proxy: { '/v1/legacy': 'http://127.0.0.1:8080' },
    },

    'docs.example.com': {
      root: 'src/docs',
      // Public and cheap to serve; no limit.
      rateLimit: false,
    },
  },
})
```

## Testing it locally

Browsers resolve any `*.localhost` name to loopback without a hosts-file entry,
so the example app uses `example.localhost`
(`apps/example/server.config.ts`). Start the server and open
`http://example.localhost:3000`.

Without a browser:

```bash
curl -H 'Host: app.example.com' http://127.0.0.1:3000/
```

That works because `Host` is what selection reads when `trustProxy` is off —
and is exactly why host selection must never stand in for authentication.
