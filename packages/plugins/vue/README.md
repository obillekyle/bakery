# @bakery-framework/plugin-vue

Vue single-file components for
[Bakery](https://github.com/obillekyle/bakery).

```bash
bun add @bakery-framework/plugin-vue vue
```

`vue` and `@vue/compiler-sfc` are peer dependencies — installing `vue` brings
the compiler with it.

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery-framework/core'
import vuePlugin from '@bakery-framework/plugin-vue'

export default defineConfig({
  root: 'src',
  plugins: [vuePlugin()],
})
```

A `.vue` file under `root` then serves as a route, alongside `.tsx` pages.
Options are typed as `VuePluginOptions`.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).

**Not an OSI-approved licence.** The Commons Clause removes the right to *sell*
the software — meaning to charge for a product or service whose value derives
substantially from it, hosting and support included. Everything else the MIT
licence grants is unchanged: use it, modify it, ship it inside your own product.
If your organisation only permits OSI-approved dependencies, this will not pass
that check.
