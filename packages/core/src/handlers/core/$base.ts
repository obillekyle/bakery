/** biome-ignore-all lint/suspicious/noAssignInExpressions: dynamic */
import { LRUCache } from '../../cache/lru'
import type { MapOf, MixedPromise } from '../../types'
import { fs } from '../../utils/fs'
import { processBody } from '../../utils/http'

const RX_PARAM = /[[\]{}()*+?.\\^$|]/g
export const RX_DYNAMIC = /\[([\w$]+)\]/
export const RX_CATCHALL = /\[\.\.\.([\w$]+)\]/

export function getDynamicRoute(path: string): Handler.Dynamic.Route | null {
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleanPath) return null
  if (!RX_DYNAMIC.test(cleanPath) && !RX_CATCHALL.test(cleanPath)) return null

  const params: string[] = []
  const segments = cleanPath.split('/')
  const last = segments.length - 1
  let catchAll = false

  const mappedPaths: string[] = []
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]

    const catchAllMatch = segment.match(RX_CATCHALL)
    if (catchAllMatch) {
      // Only terminal: a segment after `[...x]` has no unambiguous meaning
      // (which segments belong to the rest?), so the file stays inert — the
      // same behavior it had before catch-alls existed.
      if (i !== last) return null
      params.push(catchAllMatch[1])
      // `.+` rather than `.*`: the catch-all requires at least one segment,
      // so `docs/[...slug]` does not shadow a `docs/index` sibling for
      // `/docs` itself.
      mappedPaths.push('(.+)')
      catchAll = true
      continue
    }

    const dynamicMatch = segment.match(RX_DYNAMIC)
    if (dynamicMatch) {
      params.push(dynamicMatch[1])
      mappedPaths.push('([^/]+?)')
      continue
    }

    mappedPaths.push(segment.replace(RX_PARAM, '\\$&'))
  }

  return {
    pattern: new RegExp(`^/${mappedPaths.join('/')}(?:\\.([a-z]*))?$`),
    params,
    catchAll,
  }
}

export namespace RouteData {
  export interface Info {
    readonly file: Bun.BunFile
    readonly filePath: fs.AbsolutePath
    readonly path: fs.RelativePath
    readonly params: string[]
    readonly valid: boolean
    readonly isDynamic: boolean
    readonly catchAll: boolean
    readonly regex: RegExp | null
    getParams(path: string): MapOf<string> | null
  }

  export type Meta = {
    type: 'endpoint' | 'route' | 'proxy' | 'static' | 'websocket'
    isRoot: boolean
    fileName: string
  }
}

export namespace Route {
  export type Info = RouteData.Info
  export type Meta = RouteData.Meta
}

export class RouteData {
  static Info = class Info {
    readonly params: string[]
    readonly filePath: fs.AbsolutePath
    readonly path: fs.RelativePath
    readonly regex: RegExp | null
    readonly catchAll: boolean

    constructor(filePath: fs.AbsolutePath, path: fs.RelativePath) {
      this.filePath = fs.resolve(filePath) as fs.AbsolutePath
      this.path = path

      const route = getDynamicRoute(path)
      this.regex = route?.pattern || null
      this.params = route?.params || []
      this.catchAll = route?.catchAll || false
    }

    get file() {
      return Bun.file(this.filePath)
    }

    get valid() {
      return fs.exists(this.filePath)
    }

    get isDynamic() {
      return this.regex !== null
    }

    getParams(path: string): MapOf<string> | null {
      if (!this.regex) return null
      const cleanPath = path.startsWith('/') ? path : `/${path}`
      const match = cleanPath.match(this.regex)
      if (!match) return null

      const boundParams: MapOf<string> = {}
      for (let i = 0; i < this.params.length; i++) {
        boundParams[this.params[i]] = match[i + 1]
      }
      return boundParams as MapOf<string>
    }
  }
}

export namespace Handler {
  export type Response = MixedPromise<
    globalThis.Response | Bun.BunFile | undefined | object | string | void
  >

  export namespace Dynamic {
    export type Config = {
      ext: string[]
      dir?: fs.AbsolutePath
      include?: string[]
    }

    export type Route = {
      pattern: RegExp
      params: string[]
      /** True when the final segment is a `[...name]` multi-segment matcher. */
      catchAll?: boolean
    }
  }

  export namespace Route {
    export type Info = RouteData.Info
    export type Meta = RouteData.Meta
  }

  export namespace Error {
    export type Data = {
      errorCode: number
      errorText: string
      errorBody: string
    }
  }
}

/**
 * Keyed by class identity rather than stored as a `${name}_cache` dynamic
 * property: the getter runs several times per request, and the template
 * string + megamorphic property lookup showed up in profiles. A `Map` (not
 * `WeakMap`) is fine — handler classes live for the process.
 */
const handlerCaches = new Map<any, HandlerCache<string, Route.Info>>()

export class Handler {
  /**
   * Opt out of the route cache's bypass.
   *
   * `HandlerMap.resolve` remembers which handler served a path and goes
   * straight to it next time, skipping every handler above it. That is safe
   * when `canHandle` answers a *routing* question ("is there a .tsx file
   * here?"), because the answer is a property of the path. It is unsafe when
   * `canHandle` answers a question about *this* request:
   * `MiddlewareHandler.canHandle` is `Boolean(response)`, i.e. "was this
   * request denied", so an allowed request caches the page handler and every
   * later request to that path is served without the gate ever running.
   *
   * A handler that sets this is consulted before any cache hit it outranks,
   * and is never itself written into the cache.
   */
  static alwaysResolve = false

  protected constructor() {}

  static get cache(): HandlerCache<string, Route.Info> {
    let cache = handlerCaches.get(this)
    if (!cache) {
      cache = new HandlerCache()
      handlerCaches.set(this, cache)
    }
    return cache
  }

  static canHandle(path: string, req: Request): MixedPromise<boolean>
  static canHandle(): boolean {
    return false
  }

  static Route = RouteData
  static initRoutes(): MixedPromise<void> {}

  static async params(
    req: Request,
    overrides?: MapOf<any>,
  ): Promise<MapOf<any>> {
    const body = await processBody(req)
    return Object.assign({}, body, overrides)
  }

  static handle(path: string, req: Request): Handler.Response
  static handle() {
    return undefined
  }

  static [Symbol.hasInstance](instance: any): boolean {
    if (!instance) return false
    return (
      instance === this ||
      (typeof instance === 'function' && instance.prototype instanceof this) ||
      Object.prototype.isPrototypeOf.call(this.prototype, instance)
    )
  }
}

export class HandlerCache<K, V> extends LRUCache<K, V> {
  constructor(cacheSize = import.meta.env.THREAD_WORKER ? 50 : 500) {
    super(cacheSize)
  }
}
