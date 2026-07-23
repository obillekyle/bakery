import type * as _schema from '~/schema'
import type { Handler } from './handlers/core/$base'
import type * as HandlerError from './handlers/core/$error'
import type * as HandlerRegistry from './handlers/core/$registry'
import type * as HandlerWs from './handlers/core/$websocket'
import type * as _logger from './logger/logger'
import type * as _plugins from './plugins/types'
import type { Session } from './session'

declare global {
  var createElement: typeof import('./core/jsx').createElement
  var Fragment: typeof import('./core/jsx').Fragment
  var html: typeof import('./core/jsx').html

  type JsonResponse<T = any> = {
    time: number
    status: number
    message: string
    data?: T
  }

  type InjectScript = {
    src: string
    module?: boolean
    async?: boolean
    defer?: boolean
    inBody?: boolean
  }

  type HostEntry = {
    root?: string
    importMap?: Record<string, string>
    middleware?: ((
      req: Request,
      server: Bun.Server<any>,
    ) => MixedPromise<Response | void>)[]
    onRequest?(req: Request): MixedPromise<any>
    onError?(error: Handler.Error.Data): MixedPromise<any>
    head?: string
    body?: string
    proxy?: Record<string, string>
    blocked?: string[]
    rateLimit?:
      | {
          max: number
          refill: number
          keyBy?: (req: Request) => string
        }
      | false
  }

  type AppConfig = {
    root?: string

    port?: number

    host?: string

    importMap?: Record<string, string>

    backups?: number

    proxy?: Record<string, string>

    head?: string

    body?: string

    onStart?(): MixedPromise<void>

    onRequest?(req: Request): MixedPromise<any>

    onError?(error: Handler.Error.Data): MixedPromise<any>

    onShutdown?(): MixedPromise<void>

    middleware?: ((
      req: Request,
      server: Bun.Server<any>,
    ) => MixedPromise<Response | void>)[]

    plugins?: ServerPlugin[]

    websocket?: Bun.WebSocketHandler<any>

    maxBodySize?: number

    maxCacheSize?: number

    blocked?: string[]

    rateLimit?:
      | {
          max: number
          refill: number
          keyBy?: (req: Request) => string
        }
      | false

    trustProxy?: boolean

    hosts?: Record<string, HostEntry>
  }

  type ServerPlugin = _plugins.ServerPlugin

  type Wrapped<T, Args extends any[] = []> = T | ((...args: Args) => T)
  type MixedPromise<T> = Promise<T> | T

  interface Bakery {
    server?: Bun.Server<any>
    connectedLoggers?: Set<any>
    readonly sharedPool: import('./utils/shared-pool').SharedMemoryPool
    readonly cacheDir: string
    readonly dataDir: string
    readonly version: string
    readonly root: string
    readonly serveRoot: string
    readonly apiRoot: string
    readonly config: ProcessedAppConfig
    readonly handlers: {
      readonly fetch: HandlerRegistry.HandlerMap
      readonly error: HandlerRegistry.HandlerMap<
        | typeof HandlerError.ErrorHandler
        | typeof HandlerError.DynamicErrorHandler
      >
      readonly websocket: HandlerRegistry.HandlerMap<
        typeof HandlerWs.WebSocketHandler
      >
    }
    onShutdown(hook: () => Promise<void> | void): void
    readonly shutdownHooks: (() => Promise<void> | void)[]
    readonly startNs: number
  }

  type DBSchema = _schema.DBSchema
  type DBOptionals = _schema.DBOptionals
  type MapOf<T> = { [key: string]: T }

  type LoggerEntry = _logger.LoggerEntry
  type LogLevels = _logger.LogLevels

  type ResponseFn = {
    (body?: Bun.BodyInit | null, init?: ResponseInit): Response
    json: ((status: number, message: string, data?: any) => Response) & {
      success: <T>(message: string, data?: T, status?: number) => Response
      error: <T>(status?: number, message?: string, data?: T) => Response
    }
    html: (html: string, status?: number, init?: ResponseInit) => Response
    text: (text: string, status?: number, init?: ResponseInit) => Response
    href: (url: string, status?: 301 | 302 | 307 | 308) => Response
    type: (body: any, contentType: string, init?: ResponseInit) => Response
    error: (
      error: string | Error,
      code?: number,
      init?: ResponseInit,
    ) => Response
  }

  type ISFunction = {
    (value: any, type: 'string'): value is string
    (value: any, type: 'number'): value is number
    (value: any, type: 'boolean'): value is boolean
    (value: any, type: 'bigint'): value is bigint
    (value: any, type: 'symbol'): value is symbol
    (value: any, type: 'object'): value is Record<string, any>
    (value: any, type: 'array'): value is any[]
    (value: any, type: 'null'): value is null
    (value: any, type: 'undefined'): value is undefined
    // biome-ignore lint: allow function overload for better type inference when checking for functions
    (value: any, type: 'function'): value is Function
    (value: any, type?: string): boolean
    string(value: any): value is string
    number(value: any): value is number
    boolean(value: any): value is boolean
    bigint(value: any): value is bigint
    symbol(value: any): value is symbol
    object(value: any): value is MapOf<any>
    array(value: any): value is any[]
    null(value: any): value is null
    undefined(value: any): value is undefined
    // biome-ignore lint: 2
    function(value: any): value is Function
  }

  type ApiCallback<T = any> = (
    req: Request,
    body: MapOf<any>,
    server: Bun.Server<any>,
  ) => MixedPromise<T>

  namespace JSX {
    type Element = string

    interface ElementChildrenAttribute {
      children: MapOf<any>
    }

    interface HTMLAttributes {
      class?: string
      className?: string
      id?: string
      style?: string | Record<string, string | number>
      children?: any
      tabindex?: number | string
      title?: string

      [key: `data-${string}`]: string | undefined
      [key: `aria-${string}`]: string | undefined

      [key: string]: any
    }

    interface AnchorAttributes extends HTMLAttributes {
      href?: string
      target?: string
      rel?: string
    }
    interface ImgAttributes extends HTMLAttributes {
      src?: string
      alt?: string
      width?: string | number
      height?: string | number
      loading?: 'lazy' | 'eager'
    }
    interface InputAttributes extends HTMLAttributes {
      type?: string
      value?: any
      name?: string
      placeholder?: string
      disabled?: boolean
      required?: boolean
      checked?: boolean
      autocomplete?: string
    }
    interface FormAttributes extends HTMLAttributes {
      action?: string
      method?: 'GET' | 'POST' | 'get' | 'post'
      enctype?: string
    }
    interface ScriptAttributes extends HTMLAttributes {
      src?: string
      type?: string
      defer?: boolean
      async?: boolean
    }
    interface LinkAttributes extends HTMLAttributes {
      rel?: string
      href?: string
      as?: string
      type?: string
    }
    interface MetaAttributes extends HTMLAttributes {
      name?: string
      content?: string
      charset?: string
      property?: string
    }

    interface IntrinsicElements {
      html: HTMLAttributes & { lang?: string }
      head: HTMLAttributes
      body: HTMLAttributes
      title: HTMLAttributes
      meta: MetaAttributes
      link: LinkAttributes
      script: ScriptAttributes

      div: HTMLAttributes
      span: HTMLAttributes
      p: HTMLAttributes
      h1: HTMLAttributes
      h2: HTMLAttributes
      h3: HTMLAttributes
      h4: HTMLAttributes
      h5: HTMLAttributes
      h6: HTMLAttributes
      ul: HTMLAttributes
      ol: HTMLAttributes
      li: HTMLAttributes

      a: AnchorAttributes
      img: ImgAttributes
      button: HTMLAttributes & {
        type?: 'button' | 'submit' | 'reset'
        disabled?: boolean
      }
      input: InputAttributes
      textarea: InputAttributes & {
        rows?: number | string
        cols?: number | string
      }
      form: FormAttributes
      select: HTMLAttributes & {
        name?: string
        disabled?: boolean
        required?: boolean
        multiple?: boolean
      }
      option: HTMLAttributes & {
        value?: any
        selected?: boolean
        disabled?: boolean
      }

      br: HTMLAttributes
      hr: HTMLAttributes

      [elemName: string]: HTMLAttributes
    }
  }

  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly WORKER: boolean
    readonly DEV_WORKER: boolean
    readonly THREAD_WORKER: boolean
    readonly THREAD_ID: string
    readonly TEST: boolean
    readonly MODE: 'production' | 'development' | 'dev-worker' | 'thread-worker'
    readonly SERVE_ROOT: string
  }

  interface SessionData extends MapOf<any> {}

  interface Request {
    startNs: number
    session: Session<SessionData>
    __hostname?: string
  }

  type HandlerName = string & {}
  type HrefPath = string & {}
  type UpgradeData = MapOf<any> | undefined | void
  type WebSocketData<T> = {
    this: typeof HandlerWs.WebSocketHandler
    type: 'websocket'
    orig: HandlerName
    path: HrefPath
    data: T
  }

  type Override<T, U> = Omit<T, keyof U> & U
  type ProcessedAppConfig = Override<
    Required<AppConfig>,
    {
      blocked: Bun.Glob
    }
  >

  type ServerWebSocket<T = MapOf<any>> = Override<
    Bun.ServerWebSocket,
    { data: WebSocketData<T> }
  >

  interface Blob {
    slice(start: number, end?: number, contentType?: string): Blob
  }
}
