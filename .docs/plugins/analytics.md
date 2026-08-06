# Built-in: Analytics Plugin

The Analytics plugin tracks per-request metrics and aggregates them in a SQLite database. It integrates with the Dashboard plugin to provide real-time charts and historical data.

---

## Enabling the Plugin

```typescript
// server.config.ts
import { defineConfig } from '@server/core'
import analyticsPlugin from '@plugins/analytics'

export default defineConfig({
  plugins: [
    analyticsPlugin(),
  ],
})
```

---

## What It Tracks

The analytics plugin records the following for each request:

| Metric | Description |
|--------|-------------|
| **Path** | The URL path (normalized) |
| **Method** | HTTP method (GET, POST, etc.) |
| **Status code** | HTTP response status |
| **Duration** | Request processing time in milliseconds |
| **Timestamp** | Unix timestamp of the request |
| **IP Address** | Client's remote address |
| **User Agent** | Browser/client identifier string |

Requests to internal Bakery paths (`/_livereload`, `/_client/*`, `/_virtual/*`, `/_dashboard`) are excluded from analytics.

---

## Connected Loggers

The analytics plugin exposes a `connectedLoggers` set — a collection of WebSocket connections that have subscribed to the server log stream. The LiveReload handler uses this set to forward real-time log events to connected browser devtools.

```typescript
import { connectedLoggers } from '@plugins/analytics/core'

// Broadcast a message to all connected logger terminals
for (const ws of connectedLoggers) {
  ws.send(JSON.stringify({ type: 'custom_event', payload: 'hello' }))
}
```

---

## Accessing Analytics Data

Analytics data is stored in the Bakery SQLite database. Query it directly using the query builder:

```typescript
// api/admin/analytics.ts
import { DB } from '@database'

export default async function(req: Request, body: { days?: number }) {
  const days = body.days ?? 7
  const since = Date.now() - days * 86400000

  // Top 10 most visited paths
  const topPaths = await DB.table('analytics')
    .where({ analytics: 'timestamp' }, '>=', since)
    .groupBy({ analytics: 'path' })
    .selectAll('analytics')
    .selectMath({ hits: { COUNT: '*' } })
    .orderBy('hits', 'DESC')
    .limit(10)
    .array()

  return { topPaths }
}
```

---

## Dashboard Integration

When both the `analyticsPlugin` and `dashboardPlugin` are registered, the dashboard automatically displays analytics charts including:

- Requests per hour (last 24 hours)
- Status code distribution
- Top pages by traffic
- Response time percentiles
- Unique visitor counts

See [Dashboard Plugin →](./dashboard.md) for dashboard access details.

---

## Performance Considerations

Analytics writes are batched and stored asynchronously to avoid blocking request processing. The storage uses Bakery's tiered SQLite cache with a configurable flush interval.

If analytics introduces noticeable overhead under high load (>10,000 req/s), you can disable it or reduce the sampling rate by wrapping it:

```typescript
// Sample only 10% of requests
const analyticsPlugin = (() => {
  const base = baseAnalyticsPlugin()
  return {
    ...base,
    onRoute(req: Request) {
      if (Math.random() < 0.9) return  // skip 90%
      return base.onRoute?.(req)
    },
  }
})()
```

---

*[← Plugin API](./plugin-api.md) · [Dashboard Plugin →](./dashboard.md)*

*[← Back to README](../../README.md)*
