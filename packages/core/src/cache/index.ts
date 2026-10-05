import { Bakery } from '../core/bakery'
import { HandlerMap } from '../handlers/core/$registry'

/**
 * The dev watcher's route reset, run on every change to a route file: each
 * handler's own caches, and `HandlerMap.routeCache` with them.
 *
 * The route cache is what a created file needs cleared. It remembers which
 * handler won a path, and a hit re-asks only that handler, so a winner that
 * still says yes keeps the path after a file that outranks it appears.
 * `StaticHandler` says yes to every path. Measured in a dev app: with a root
 * catch-all deleted and `/` requested (404, as livereload does on the delete),
 * `/` still answered 404 three seconds after `index.vue` was written, until
 * the dev worker restarted. And `/about` kept serving `about.html` after an
 * `about.vue` (VueHandler, 58, above HTMLHandler, 55) was written beside it.
 */
export function initRoutes() {
  HandlerMap.routeCache.clear()
  for (const [, handlers] of Object.entries(Bakery.handlers)) {
    for (const HandlerClass of handlers.list()) {
      HandlerClass.initRoutes()
    }
  }
}
