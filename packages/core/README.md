# @bakery-framework/core

The core of [Bakery](https://github.com/obillekyle/bun-server): request handling,
routing, sessions, caching and the server-side JSX runtime.

**Bun only.** This package ships TypeScript source with no build step, and the
runtime depends on Bun APIs throughout. It will not run on Node.

```bash
bun add @bakery-framework/core @bakery-framework/cli
```

`@bakery-framework/cli` owns the `bakery` binary that actually starts a server — core on
its own is the library it starts.

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery-framework/core'

export default defineConfig({
  root: 'src',
  port: 3000,
})
```

Every file under `root` is a route. A `.tsx` file is a page, a `.ts` file under
`api/` is an endpoint:

```ts
// src/api/hello.ts
import { defineRoute, response } from '@bakery-framework/core'

export default defineRoute(async req => {
  return response.json.success('ok', { method: req.method })
})
```

## JSX setup

Pages are rendered server-side through Bakery's own `createElement`, so an app's
`tsconfig.json` must set the classic runtime **locally**:

```json
{
  "extends": "@bakery-framework/core/tsconfig.app.json",
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "createElement",
    "jsxFragmentFactory": "Fragment"
  }
}
```

`extends` alone is not enough. Bun's runtime does not follow `extends` into a
package specifier, so without the three options repeated here every `.tsx` route
fails with `Cannot find module 'react/jsx-dev-runtime'` — while `tsc` stays
perfectly happy, because it *does* follow the extends.

The fastest way to get a correct setup is to let the scaffolder write one:

```bash
bun create bakery my-app
```

## Notes

- No runtime dependencies.
- An unconfigured app gets an on-by-default per-IP rate limit (100 burst,
  10 req/s). The startup banner says so; `rateLimit: false` turns it off.
- The export map is curated: only the subpaths it names can be imported, and
  everything else is private. If you need something that is not exposed, open an
  issue rather than reaching for a deep path — it will not resolve.

Full documentation lives in the
[repository](https://github.com/obillekyle/bun-server).

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE). In short: use,

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
modify and distribute freely; selling the software itself is not granted.
