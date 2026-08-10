import { definePlugin } from '@bakery-framework/core/plugins'
import { setVuePluginOptions } from './compile'
import type { VuePluginOptions } from './types'
import { rewriteVueImports } from './utils'

/**
 * `vuePlugin` is this package's only export, and its parameter type lived in a
 * `.d.ts` reachable through no working specifier — so a consumer could pass
 * options but never name their type. Re-exported here, where the function that
 * takes them is.
 */
export type { CustomElementsOption, VuePluginOptions } from './types'

export default function vuePlugin(options?: VuePluginOptions) {
  if (options) setVuePluginOptions(options)
  return definePlugin({
    name: 'vue',

    // Declarative, read by the tsconfig generator at dev boot rather than by
    // the server. `.vue` needs its own project for two reasons core cannot
    // cover: plain `tsc` cannot parse an SFC at all (so this is for `vue-tsc`),
    // and `vue.d.ts` declares `req` and `body` for SFC scope — globals core
    // deliberately does not provide. Before this, those declarations shipped in
    // the package and were reachable by no app.
    tsconfig: {
      project: {
        name: 'vue',
        extends: '@bakery-framework/core/tsconfig.vue.json',
        include: ['src/**/*.vue'],
        // A package specifier rather than a path: the plugin does not know
        // where it was installed. The generator resolves it before writing.
        files: ['@bakery-framework/plugin-vue/vue.d.ts'],
        // An SFC's `<script>` is browser code, so an `importMap` alias inside one
        // is resolved by the browser's own import map and has to typecheck. The
        // flag is off by default precisely because the *server* project must not
        // have it — an alias only the browser can satisfy would typecheck there
        // and fail at runtime. Vue is the case the flag exists to allow.
        importMapPaths: true,
      },
    },

    async setup() {
      const { setupVue } = await import('./setup')
      await setupVue()
    },
    onCompile(content, path) {
      if (
        !path.endsWith('.ts') &&
        !path.endsWith('.js') &&
        !path.endsWith('.vue')
      )
        return content

      let modified = content

      if (modified.includes('.vue"') || modified.includes(".vue'")) {
        modified = rewriteVueImports(modified)
      }

      return modified
    },
  })
}
