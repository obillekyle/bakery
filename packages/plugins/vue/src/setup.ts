import { Bakery } from '@bakery-framework/core/core/bakery'
import { Logger } from '@bakery-framework/core/logger'
import { vueChunkPath } from './chunks'
import { VueErrorHandler, VueHandler } from './handler'
import { initVueVersion } from './utils'

const logger = new Logger('vue')

function checkDeps() {
  try {
    Bun.resolveSync('vue/package.json', import.meta.dir)
  } catch {
    logger.log('"vue" is not installed. Run `bun add vue`.', 'error')
    process.exit(1)
  }
}

export function setupVue() {
  checkDeps()
  initVueVersion()
  Bakery.handlers.fetch.set(VueHandler, 58)
  Bakery.handlers.error.set(VueErrorHandler, 18)
  // `vueChunkPath` is the single writer of this URL — it carries the build
  // variant (`<version>.runtime.js` / `<version>.full.js`), and the serving
  // check in `chunks.ts` reads the same function.
  Bakery.config.importMap.vue = vueChunkPath()
}
