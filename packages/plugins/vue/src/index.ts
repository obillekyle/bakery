import { definePlugin } from '@bakery/core/plugins'
import { rewriteVueImports } from './utils'
import type { VuePluginOptions } from './types'
import { setVuePluginOptions } from './compile'

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
