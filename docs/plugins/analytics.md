# Analytics plugin

`@bakery-framework/plugin-analytics` collects request telemetry — hit counts, memory,
uptime, session count, self-measured ping — aggregates it into five time
windows, and persists it to SQLite.

> **Read this first: the read endpoints are currently unreachable in every
> configuration.** Collection works. Every way of *getting the data out* denies
> all callers, including the dashboard's stats panel. See
> [Authorization is currently a dead end](#authorization-is-currently-a-dead-end).

## Register

```ts
import { defineConfig } from '@bakery-framework/core'
import analyticsPlugin from '@bakery-framework/plugin-analytics'

export default defineConfig({
  root: 'src',
  plugins: [analyticsPlugin()],
})
```

The plugin takes no options.

## What it does

| Hook | Effect |
| --- | --- |
| `setup` | registers `AnalyticsHandler` (fetch, priority **110**) and `AnalyticsWSHandler` (websocket), loads persisted history, installs a shutdown hook that saves |
| `onRoute` | records one hit per request: method, path, query |
| `onError` | increments the error-page counter |
| `onStart` | starts a 1-second sampling loop |

The 1-second loop ([`analytics/src/loop.ts`](../../packages/plugins/analytics/src/loop.ts))
samples RSS, the connected-logger count and `Session.count`, measures its own
round-trip by fetching `/_analytics/ping` through the live server, pushes a
snapshot, throttles a save to at most once a minute, and broadcasts to any
connected stats sockets.

### Counters

`recordRouteHit` classifies each path ([`analytics/src/core.ts`](../../packages/plugins/analytics/src/core.ts)):

- paths starting `/api/` count as **API hits**;
- paths starting `/_`, and anything with a static-asset extension, are
  **excluded** from page hits entirely — this is `isAssetPath`, and it is why
  framework and plugin routes never appear in "top pages";
- everything else is a **page hit**, appended to a hit log and a per-path
  counter.

`recordDbHit` and `recordErrorPageHit` are exported for callers that want to
contribute, and `connectedLoggers` is re-exported from core — the live-reload
handler owns that registry, so it cannot live in a plugin.

### Aggregation and retention

One snapshot per second feeds five rolling arrays, each folding into the next:

| Window | Bucket | Points kept |
| --- | --- | --- |
| `1m` | 1 s | 60 |
| `1h` | 1 min (60 samples) | 60 |
| `1d` | 30 min (1800 samples) | 48 |
| `7d` | 6 h (21600 samples) | 28 |
| `30d` | 24 h (86400 samples) | 30 |

Counters (hits, unique requests) are summed across a bucket; gauges (memory,
sessions, ping) are averaged. Gaps are filled with `null` points so a chart
shows downtime rather than interpolating across it.

The raw page-hit log is pruned every 60 s to a 30-day retention and a hard cap
of 50 000 entries; the per-path counter is decremented as entries fall off, so
the two never drift.

### Persistence

State goes to the shared SQLite store (`bakery/sessions.db`) in two
tables, `page_hits` and `core`, written at most once a minute and again on
shutdown. On boot, page hits older than 24 hours are dropped and at most 5000
are restored.

## Endpoints

| Route | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/_analytics/ping` | any | **none** | returns `pong`; the sampling loop fetches it to measure its own latency |
| `/api/_analytics/stats` | any | required | the snapshot payload: process info, counters, top 10 pages, history |
| `/api/_analytics/reset` | POST | required | clears all history and page hits, then saves |
| `/_analytics_ws` | WS | required | pushes a stats frame every second; the client sends `{"type":"subscribe", timescale, pagesFilter, excludeHistory}` |

`/api/_analytics/stats` takes `?timescale=1m|1h|1d|7d|30d`,
`?pagesFilter=<timescale>|all` (which window "top pages" is computed over) and
`?excludeHistory=true` (omit the series, keep the latest point).

The two `/api/` endpoints return the standard JSON envelope; the router
serialises it. The route table is declared with `routeTable(... satisfies
PluginRouteTable)` — see [Plugin API](plugin-api.md#declaring-endpoints-with-routetable)
for why the `satisfies` matters.

## Authorization is currently a dead end

`isAnalyticsAuthorized` requires **both** conditions
([`analytics/src/endpoints/stats.ts`](../../packages/plugins/analytics/src/endpoints/stats.ts)):

```ts no-check — the current implementation, quoted; it is not something to copy
export function isAnalyticsAuthorized(req: Request): boolean {
  if (!process.env.DASHPASS) return false
  return Boolean(req.session?.get(DASHPASS_SESSION_KEY))
}
```

`DASHPASS_SESSION_KEY` is `__bakery.dashpass`. **Nothing in the repository
writes that key.** It used to be set by the dashboard's login form, and that
whole login flow was deleted when the dashboard moved to an
[`authorize(req)` predicate](dashboard.md). The orphaned `LoginForm`
component that outlived it has since been deleted too.

The consequences, precisely:

- `/api/_analytics/stats` returns 404 when `DASHPASS` is unset and 401 when it
  is set. There is no third case.
- `/api/_analytics/reset` behaves identically.
- `/_analytics_ws` refuses the upgrade — the check is in `canHandle`, because
  the upgrade happens before any plugin hook runs
  ([`analytics/src/endpoints/websocket.ts`](../../packages/plugins/analytics/src/endpoints/websocket.ts)).
- The dashboard's Overview panel therefore cannot load. It calls
  `/_analytics_ws` and `/api/_analytics/reset` by hardcoded URL, so the failure
  looks like a dead panel rather than a missing dependency.

This **fails closed**. It is a dead feature, not an exposure — the earlier
version of this check returned "authorized" when `DASHPASS` was unset, which
meant the documented way to *disable* the dashboard published process stats and
top pages to anyone. That is fixed; the fix is what left the endpoints
unreachable. The regression tests in
[`analytics-auth.test.ts`](../../packages/plugins/analytics/src/analytics-auth.test.ts)
pin the closed behaviour.

Deciding what should replace it — most likely the same `AuthorizeFn` the
dashboard takes ([`plugins/dashboard/src/authorize.ts`](../../packages/plugins/dashboard/src/authorize.ts))
— is a security decision rather than a cleanup, and is deliberately not being
made in passing. Until then: collection is live and persisted, and the data is
readable only by querying `bakery/sessions.db` directly, or in-process via
the export below.

## Programmatic access

The collected state is exported, so an application can read it in-process
without going through the guarded endpoints:

```ts
import { history1m, pageHitsMap, recordDbHit } from '@bakery-framework/plugin-analytics'

export function summary() {
  recordDbHit()
  return {
    lastSample: history1m[history1m.length - 1],
    distinctPaths: pageHitsMap.size,
  }
}
```

`computeStats(timescale, excludeHistory, pagesFilter)` from
`@bakery-framework/plugin-analytics/endpoints/stats` builds the same payload the HTTP
endpoint would return, without the authorization check — it is the function the
guard sits in front of, not behind. Exposing it on your own route means you own
the access decision.
