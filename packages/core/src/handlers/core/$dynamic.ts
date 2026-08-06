import Bakery from '../../core'
import { hostKey } from '../../core/bakery'
import { matchBlockedCached } from '../../core/context'
import { errorMsg, handlerLog } from '../../logger/serve-log'
import type { MixedPromise } from '../../types'
import { fs, Try } from '../../utils'
import {
  Handler,
  HandlerCache,
  type Route,
  RX_CATCHALL,
  RX_DYNAMIC,
} from './$base'
import { resolveMount } from './$mounts'
import { getRoute } from './$routing'

const dynamicCaches = new Map<any, HandlerCache<RegExp, Route.Info>>()

export class DynamicHandler extends Handler {
  static get config(): Handler.Dynamic.Config {
    return {
      ext: [],
      dir: Bakery.serveRoot,
      include: ['**/*'],
    }
  }

  static get dynamicCache(): HandlerCache<RegExp, Route.Info> {
    // Same per-class Map pattern as `Handler.cache` — see the comment there.
    let cache = dynamicCaches.get(this)
    if (!cache) {
      cache = new HandlerCache()
      dynamicCaches.set(this, cache)
    }
    return cache
  }

  static initRoutes() {
    this.cache.clear()
    this.dynamicCache.clear()
  }

  static canHandle(path: string, req?: Request): MixedPromise<boolean>
  static async canHandle(path: string) {
    // A request path spelled like a route template ('/blog/[id]' or
    // '/docs/[...slug]') addresses the template file, not a route.
    if (RX_DYNAMIC.test(path) || RX_CATCHALL.test(path)) return false
    if (this.cache.has(hostKey(path))) return true
    // The dynamic half of the line above. A dynamic route is never written to
    // `this.cache`, so without this every request to one ran `resolveRoute`
    // twice — once here and once in `handle` — and each run is two globbing
    // `getRoute` scans. `findDynamicRoute` is a regex test per cached route
    // plus one stat for the match, and a hit here implies `resolveRoute` is
    // about to be truthy too: it consults the same cache and returns that
    // entry unless a static file outranks it, which is also truthy. The
    // side effects skipped (cache population) are redone by `handle`.
    if (this.findDynamicRoute(path)) return true
    const info = await this.resolveRoute(path)
    return Boolean(info)
  }

  static async executeModule(
    file: fs.AbsolutePath,
    req: Request,
    body: any,
  ): Promise<any> {
    // A broken route module is a server fault, not a missing route: `null`
    // means 404 to every caller, so after logging the file for context the
    // failure is rethrown. `extractErrorData` turns the throw into a 500 whose
    // `errorBody` carries the stack — shown in DEV, redacted by `publicBody`
    // in PROD. Only the genuinely-missing cases below return null.
    const [error, mod] = await Try.catch(import(file))
    if (error) {
      handlerLog.API_IMPORT_ERR({ file, error: errorMsg(error) })
      throw error
    }

    if (mod?.default === undefined) return null
    if (typeof mod.default !== 'function') return mod.default

    // `ApiCallback` declares three parameters and this is its only call site,
    // so the third was always `undefined`. Passed rather than removed from the
    // type: `html()` in core/jsx.ts already hands `Bakery.server` to the render
    // function it wraps, so dropping it would leave wrapped and unwrapped
    // routes with different signatures for no gain.
    return await mod.default(req, body, Bakery.server)
  }

  static findDynamicRoute(path: string): Route.Info | null {
    const root = Bakery.serveRoot
    let deferred: Route.Info[] | null = null
    for (const [_, info] of this.dynamicCache) {
      // Cheapest filter first. `valid` is a stat and `isForbidden` walks every
      // directory between the file and the root doing an existsSync at each
      // level, and both ran for every cached route before anything asked
      // whether the route even matched the path — so a miss cost one tree-walk
      // per entry and a hit cost one per entry ahead of the match. The regex is
      // pure and all four filters still `continue`, so a matching-but-rejected
      // entry does not shadow a later one; `$dynamic.test.ts` pins that.
      if (!info.getParams(path)) continue
      // Every single-segment route outranks every catch-all, whatever order
      // the cache filled in — so catch-alls are set aside, and their stat and
      // tree-walk filters run only after the loop finds no specific match.
      if (info.catchAll) {
        ;(deferred ??= []).push(info)
        continue
      }
      if (!info.valid) continue
      // `filePath` is already `fs.resolve`d by the Info constructor; resolving
      // it again here re-normalised an identical string.
      if (!info.filePath!.startsWith(`${root}/`)) continue
      if (fs.isForbidden(info.filePath!, root)) continue
      return info
    }
    if (deferred) {
      // A real file always beats a catch-all, whatever handler would serve
      // it: when the requested path names an existing file, every catch-all
      // declines so the file's own handler (possibly lower-priority — CSS
      // falls all the way to StaticHandler) gets asked. One stat, paid only
      // when a catch-all is about to answer. `getCatchAllRoute` applies the
      // same rule on the discovery path; the two must agree — including the
      // containment clamp: `root + path` is unresolved, so a `..` in the
      // path would have `statSync` resolve it outside the root and turn this
      // into an existence probe. See the comment there.
      const target = fs.resolve(root, `.${path}`)
      if (
        (target === root || target.startsWith(`${root}/`)) &&
        fs.isFileSync(target)
      ) {
        return null
      }
      // Longest route path first: `docs/guides/[...rest]` beats
      // `docs/[...rest]` for the paths both match.
      if (deferred.length > 1) {
        deferred.sort((a, b) => b.path.length - a.path.length)
      }
      for (const info of deferred) {
        if (!info.valid) continue
        if (!info.filePath!.startsWith(`${root}/`)) continue
        if (fs.isForbidden(info.filePath!, root)) continue
        return info
      }
    }
    return null
  }

  static getCachedRoute(path: string): Route.Info | null {
    const key = hostKey(path)
    return this.validateCachedRoute(key, this.cache.get(key)!)
  }

  static cacheStaticRoute(path: string, info: Route.Info): Route.Info {
    const key = hostKey(path)
    this.cache.set(key, info)

    if (path.endsWith('/index')) {
      this.cache.set(hostKey(path.slice(0, -6) || '/'), info)
    }
    return info
  }

  static validateCachedRoute(path: string, info: Route.Info | null) {
    if (!info) return null
    if (info.valid && !fs.isForbidden(info.filePath!, Bakery.serveRoot)) return info
    this.cache.delete(path)
    if (info.regex) this.dynamicCache.delete(info.regex)
    return null
  }

  /**
   * Resolve `path` to a file this handler may serve.
   *
   * The deny-list is matched against the *request path* in `router.ts`, but
   * `routeGlobs` deliberately answers a request with a file of a different
   * extension — `/schema.css` and `/schema` both resolve to `schema.ts` via
   * stem+ext substitution. So the router's check was being asked about a
   * string that named no file: it said "not blocked", and `TSHandler`
   * compiled and served the very file the default list exists to protect.
   * Verified against a live server before the fix: `/schema.ts` 403,
   * `/schema.js` 200 with the file's contents.
   *
   * Re-running the check against what actually resolved is the fix. It is
   * gated on `servesFiles` so route-only handlers keep their exemption, and
   * it wraps every branch — cached, static, dynamic, catch-all — rather than
   * each return point, so a future branch cannot forget it.
   */
  static resolveRoute(path: string): Promise<Route.Info | null>
  static async resolveRoute(path: string) {
    const info = await this.resolveRouteFile(path)
    if (!info) return null

    if (
      this.servesFiles &&
      matchBlockedCached(Bakery.config.blocked, `/${info.path}`)
    ) {
      return null
    }

    return info
  }

  protected static resolveRouteFile(path: string): Promise<Route.Info | null>
  protected static async resolveRouteFile(path: string) {
    const cached = this.getCachedRoute(path)
    if (cached) return cached

    // One read of the `config` getter: every access builds a fresh object and
    // reads `Bakery.serveRoot` (an AsyncLocalStorage getStore), and this
    // function used to read it three times.
    const config = this.config

    // A plugin may claim this prefix and serve it from its own directory; the
    // rest of the pipeline (compiler, caches, containment) is unchanged.
    const mounted = resolveMount(path)
    const dir = mounted ? mounted.mount.dir : config.dir || Bakery.serveRoot
    const routePath = mounted ? mounted.rest : path

    const staticInfo = await getRoute(
      routePath,
      config.ext,
      dir,
      dir,
      { staticOnly: true },
    )
    if (staticInfo) {
      return this.cacheStaticRoute(path, staticInfo)
    }

    // `findDynamicRoute` already required `valid` and `!isForbidden` against
    // `Bakery.serveRoot` before returning, so wrapping it in
    // `validateCachedRoute` — which asserts exactly those two, against exactly
    // that root — re-ran a stat and a directory tree-walk on a value that had
    // just passed both, and its eviction branch was unreachable from here.
    // `getCachedRoute` still needs the wrapper; entries read from `this.cache`
    // have not been checked.
    const dyn = this.findDynamicRoute(path)
    if (dyn) {
      return dyn
    }

    const info = await getRoute(
      routePath,
      config.ext,
      dir,
      dir,
      { dynamicOnly: true },
    )
    if (!info) return null

    if (info.isDynamic && info.regex) {
      this.dynamicCache.set(info.regex, info)
      return info
    }

    return this.cacheStaticRoute(path, info)
  }
}
