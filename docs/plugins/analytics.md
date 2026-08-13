# Analytics plugin

`@bakery-framework/plugin-analytics` collects request telemetry — hit counts, memory,
uptime, session count, self-measured ping — aggregates it into five time
windows, and persists it to SQLite.

> **Read this first: the read endpoints are closed until you set a
> credential.** Collection always works; getting the data out needs
> `analyticsPlugin({ credential })`. See [Authorization](#authorization).

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

## Authorization

Set a shared credential and the endpoints open to anything presenting it:

```ts no-check — import.meta.env keys are app-defined
analyticsPlugin({ credential: import.meta.env.ANALYTICS_KEY })
```

Present it as `Authorization: Bearer <key>`, an `x-analytics-key` header, or
an `?analytics-key=<key>` query. The compare is constant time and lives in
core (`requestHasCredential`), shared with the db-explorer plugin; an unset
or empty variable turns the door **off**, never open.

`isAnalyticsAuthorized` checks two doors, both fail-closed
([`analytics/src/endpoints/stats.ts`](../../packages/plugins/analytics/src/endpoints/stats.ts)):

- the credential above, and
- an optional `authorize(req)` predicate, for applications that gate by their
  own roles rather than by a shared key. Either door admits.

With neither configured analytics is closed to everyone. That is the safe
default — an earlier version returned "authorized" when the old `DASHPASS`
variable was unset, publishing process stats to anyone — and it is the reason
the plugin ships off rather than open.

**This is the dashboard's door too.** `@bakery-framework/plugin-analytics` is
a hard dependency of [`@bakery-framework/plugin-dashboard`](dashboard.md),
which forwards its own `authorize` and `credential` here and guards
`/_dashboard` with `isAnalyticsAuthorized`: the analytics key *is* the
dashboard key. Configure it on either plugin — a call that omits an option
leaves whatever the other one set, so registration order does not decide the
answer.

Applied uniformly:

- `/api/_analytics/stats` and `/api/_analytics/reset` return 401 when a door
  is armed but the request fails it, 404 when neither door is configured — the
  404 does not advertise the endpoint.
- `/_analytics_ws` honours the same check in `canHandle`, because the upgrade
  happens before any plugin hook runs
  ([`analytics/src/endpoints/websocket.ts`](../../packages/plugins/analytics/src/endpoints/websocket.ts)).

The regression tests in
[`analytics-auth.test.ts`](../../packages/plugins/analytics/src/analytics-auth.test.ts)
pin both doors, the off-when-unset default, and that a bare `setupAnalytics`
call does not clear what a configured one set. The dashboard half is pinned in
[`dashboard/src/setup.test.ts`](../../packages/plugins/dashboard/src/setup.test.ts).

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
