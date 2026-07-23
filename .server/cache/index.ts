import { Bakery } from '@server/core/bakery'
export function initRoutes() {
  for (const [, handlers] of Object.entries(Bakery.handlers)) {
    for (const HandlerClass of handlers.list()) {
      HandlerClass.initRoutes()
    }
  }
}
