# @bakery/plugin-analytics

Request, route and error metrics for
[Bakery](https://github.com/obillekyle/bun-server), with a live WebSocket feed.

```bash
bun add @bakery/plugin-analytics
```

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery/core'
import analyticsPlugin from '@bakery/plugin-analytics'

export default defineConfig({
  root: 'src',
  plugins: [analyticsPlugin()],
})
```

Rolling histories are exported for reading directly — `history1m`, `history1h`,
`history1d`, `history7d`, `history30d` — alongside `pageHitsMap`,
`pageHitsLog` and the `recordRouteHit` / `recordDbHit` / `recordErrorPageHit`
counters.

The stats endpoint is guarded by `DASHPASS`. The safe state is the default:
with `DASHPASS` unset the guard **denies everyone**, so the endpoint is closed
until you deliberately open it. Setting `DASHPASS` is what enables access, and a
caller still needs the matching session flag.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).
