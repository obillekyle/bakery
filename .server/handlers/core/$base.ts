/** biome-ignore-all lint/suspicious/noAssignInExpressions: dynamic */
import { LRUCache } from '@server/cache/lru'
import { fs } from '@server/utils/fs'
import { processBody } from '@server/utils/http'

const RX_PARAM = /[[\]{}()*+?.\\^$|]/g
export const RX_DYNAMIC = /\[([\w$]+)\]/

export function getDynamicRoute(path: string): Handler.Dynamic.Route | null {
  const cleanPath = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleanPath || !RX_DYNAMIC.test(cleanPath)) return null

  const params: string[] = []

  const mappedPaths = cleanPath.split('/').map(segment => {
    const dynamicMatch = segment.match(RX_DYNAMIC)

    return dynamicMatch
      ? (params.push(dynamicMatch[1]), '([^/]+?)')
      : segment.replace(RX_PARAM, '\\$&')
  })

  return {
    pattern: new RegExp(`^/${mappedPaths.join('/')}(?:\\.([a-z]*))?$`),
    params,
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

    constructor(filePath: fs.AbsolutePath, path: fs.RelativePath) {
      this.filePath = fs.resolve(filePath) as fs.AbsolutePath
      this.path = path

      const route = getDynamicRoute(path)
      this.regex = route?.pattern || null
      this.params = route?.params || []
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

export class Handler {
  static cacheSize = import.meta.env.THREAD_WORKER ? 20 : 100
  protected constructor() {}

  static get cache(): HandlerCache<string, Route.Info> {
    const handlerName = `${this.name}_cache`
    return ((this as any)[handlerName] ??= new HandlerCache())
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
