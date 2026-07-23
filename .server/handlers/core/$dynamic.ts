import Bakery from '@server/core'
import { hostKey } from '@server/core/bakery'
import { fs, Try } from '@server/utils'
import { Handler, HandlerCache, type Route, RX_DYNAMIC } from './$base'
import { getRoute } from './$routing'

export class DynamicHandler extends Handler {
  static get config(): Handler.Dynamic.Config {
    return {
      ext: [],
      dir: Bakery.serveRoot,
      include: ['**/*'],
    }
  }

  static get dynamicCache(): HandlerCache<RegExp, Route.Info> {
    const cacheName = `${this.name}_dynamicCache`
    ;(this as any)[cacheName] ??= new HandlerCache()
    return (this as any)[cacheName]
  }

  static initRoutes() {
    this.cache.clear()
    this.dynamicCache.clear()
  }

  static canHandle(path: string, req?: Request): MixedPromise<boolean>
  static async canHandle(path: string) {
    if (RX_DYNAMIC.test(path)) return false
    if (this.cache.has(hostKey(path))) return true
    const info = await this.resolveRoute(path)
    return Boolean(info)
  }

  static async executeModule(
    file: fs.AbsolutePath,
    req: Request,
    body: any,
  ): Promise<any> {
    const mod = await Try(import(file))
    if (mod?.default === undefined) return null
    if (typeof mod.default !== 'function') return mod.default

    return await mod.default(req, body)
  }

  static findDynamicRoute(path: string): Route.Info | null {
    const root = Bakery.serveRoot
    for (const [_, info] of this.dynamicCache) {
      if (!info.valid) continue
      if (!fs.resolve(info.filePath!).startsWith(root)) continue
      if (fs.isForbidden(info.filePath!, root)) continue
      if (info.getParams(path)) return info
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

  static resolveRoute(path: string): Promise<Route.Info | null>
  static async resolveRoute(path: string) {
    const cached = this.getCachedRoute(path)
    if (cached) return cached

    const dir = this.config.dir || Bakery.serveRoot

    const staticInfo = await getRoute(
      path,
      this.config.ext,
      dir,
      dir,
      { staticOnly: true },
    )
    if (staticInfo) {
      return this.cacheStaticRoute(path, staticInfo)
    }

    const key = hostKey(path)
    const dyn = this.validateCachedRoute(key, this.findDynamicRoute(path))
    if (dyn) {
      return dyn
    }

    const info = await getRoute(
      path,
      this.config.ext,
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
