# @bakery/plugin-dashboard

A built-in admin console for
[Bakery](https://github.com/obillekyle/bun-server): database browsing, logs and
runtime state.

```bash
bun add @bakery/plugin-dashboard
```

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery/core'
import dashboardPlugin from '@bakery/plugin-dashboard'

export default defineConfig({
  root: 'src',
  plugins: [
    dashboardPlugin({
      authorize: req => Boolean(req.session?.get('isAdmin')),
    }),
  ],
})
```

**The dashboard does not authenticate anyone itself.** Your application already
knows who its users are, so it decides: `authorize` returns true to allow a
request through. Ship it without one and you are exposing your database browser.

`enabled: false` keeps it out of a build entirely — the documented way to
disable it in production.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
