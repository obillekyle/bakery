import { Bakery } from '@bakery/core/core/bakery'
import { Logger } from '@bakery/core/logger'
import { VueErrorHandler, VueHandler } from './handler'
import { initVueVersion, VUE_VERSION } from './utils'

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
  Bakery.config.importMap['vue'] = `/_vue/${VUE_VERSION}.js`
}
