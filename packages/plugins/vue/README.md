# @bakery/plugin-vue

Vue single-file components for
[Bakery](https://github.com/obillekyle/bun-server).

```bash
bun add @bakery/plugin-vue vue
```

`vue` and `@vue/compiler-sfc` are peer dependencies — installing `vue` brings
the compiler with it.

## Usage

```ts
// server.config.ts
import { defineConfig } from '@bakery/core'
import vuePlugin from '@bakery/plugin-vue'

export default defineConfig({
  root: 'src',
  plugins: [vuePlugin()],
})
```

A `.vue` file under `root` then serves as a route, alongside `.tsx` pages.
Options are typed as `VuePluginOptions`.

## License

MIT with the Commons Clause v1.0 — see [LICENSE](./LICENSE).
