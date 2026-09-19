# @bakery-framework/plugin-analytics

Request, route and error metrics for
[Bakery](https://github.com/obillekyle/bakery), with a live WebSocket feed.

```bash
bun add @bakery-framework/plugin-analytics
```

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery-framework/core'
import analyticsPlugin from '@bakery-framework/plugin-analytics'

export default defineConfig({
  root: 'src',
  plugins: [analyticsPlugin()],
})
```

Rolling histories are exported for reading directly — `history1m`, `history1h`,
`history1d`, `history7d`, `history30d` — alongside `pageHitsMap`,
`pageHitsLog` and the `recordRouteHit` / `recordErrorPageHit` counters.

## Authorization

The stats endpoint, the reset endpoint and the live socket are closed unless
you open them, and there are two ways to do it:

```ts
import { defineConfig } from '@bakery-framework/core'
import analyticsPlugin from '@bakery-framework/plugin-analytics'

export default defineConfig({
  plugins: [
    analyticsPlugin({
      // A shared secret, sent as an `x-analytics-key` header or, for the
      // socket, an `analytics-key` query parameter — a browser cannot set a
      // header on a WebSocket handshake.
      credential: process.env.ANALYTICS_KEY,

      // Or your own predicate, which is what the dashboard plugin hands over
      // when both are registered.
      authorize: (req: Request) => req.headers.get('x-role') === 'admin',
    }),
  ],
})
```

With neither configured the guard allows loopback in development and denies
everything in production, so the closed state is the default rather than
something to remember.

**`DASHPASS` is not read and has not been since `bfe410c`.** Earlier versions
of this file said the endpoint was guarded by it. It never granted access —
it changed a status code — and nothing in the framework consults it now.
Delete it from any environment that still carries it: a variable that looks
like a credential and controls nothing is the kind of leftover an operator
reasons from. See
[Environment](https://github.com/obillekyle/bakery/blob/main/docs/configuration/environment.md).

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
