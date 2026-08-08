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

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
