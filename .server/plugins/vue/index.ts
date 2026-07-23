import { definePlugin } from '@plugins/types'
import { rewriteVueImports, VUE_VERSION } from './utils'

export default function vuePlugin() {
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
