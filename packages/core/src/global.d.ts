import type { Handler } from './handlers/core/$base'
import type * as HandlerError from './handlers/core/$error'
import type * as HandlerRegistry from './handlers/core/$registry'
import type * as HandlerWs from './handlers/core/$websocket'
import type * as _logger from './logger/logger'
import type * as _plugins from './plugins/types'
import type { Session } from './session'
import type { MapOf, MixedPromise } from './types'

/**
 * File-local, deliberately not global and not exported: its only two uses are
 * the two definitions below it. A global `type Override` is the kind of name a
 * consuming app is likely to want for itself.
 */
type Override<T, U> = Omit<T, keyof U> & U

declare global {
  // Bound on globalThis by core/init.ts, which is why they are declared and
  // not imported. `createElement` and `Fragment` additionally *have* to be
  // global: tsconfig sets jsxFactory/jsxFragmentFactory, and the classic JSX
  // runtime resolves those names in global scope.
  //
  // `var req: Request` and `var body: any` used to live here too. Nothing ever
  // assigned them — not init.ts, not client/utils.ts, nothing — so
  // `req.headers.get('host')` typechecked anywhere in the codebase and threw
  // `ReferenceError: req is not defined` when it ran. A global that only
  // exists in the type system is worse than no global at all.
  var createElement: typeof import('./core/jsx').createElement
  var Fragment: typeof import('./core/jsx').Fragment
  var html: typeof import('./core/jsx').html

  // JsonResponse and ISFunction are declared once, in shared.d.ts — the
  // browser runtime needs them too. MapOf, Wrapped and MixedPromise are not
  // global at all any more; they are imported from ./types above.
  //
  // `Mutable<T>` used to sit here. It had one declaration and zero consumers
  // anywhere in the repo, so it is deleted rather than moved.

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

    // `maxCacheSize?: number` was declared and defaulted to 500 here, and read
    // by nothing: the route LRUs size themselves and the tiered cache takes its
    // own options. Deleted rather than wired up — there is no single cache it
    // plausibly governs, and a knob that silently does nothing is worse than an
    // absent one. Removing it before the first publish is a docs note; after,
    // it is a breaking change.

    blocked?: string[]

    rateLimit?:
      | {
          max: number
          refill: number
          keyBy?: (req: Request) => string
        }
      | false

    trustProxy?: boolean

    /**
     * Where the ORM finds the app's schema — a file, or a folder containing
     * `index.ts`. Relative paths resolve against the app's cwd. Omit it (or
     * leave it empty) to auto-detect `orm/` then `schema.ts`.
     *
     * A plain string, deliberately: core must never depend on `@bakery-framework/orm`,
     * which depends on core, and a path carries no type from it. The ORM reads
     * this through `schemaFromConfig`. A configured path that does not exist is
     * a hard error rather than a fall back to auto-detect — otherwise a typo
     * makes the sync engine generate a fresh schema at the wrong path while the
     * real one sits untouched.
     */
    schema?: string

    hosts?: Record<string, HostEntry>
  }

  type ServerPlugin = _plugins.ServerPlugin

  interface Bakery {
    server?: Bun.Server<any>
    readonly sharedPool: import('./utils/shared-pool').SharedMemoryPool
    readonly cacheDir: string
    readonly dataDir: string
    readonly version: string
    readonly root: string
    readonly serveRoot: string
    readonly apiRoot: string
    readonly publicRoot: string
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

  // DBSchema / DBOptionals are declared by the orm package (its own
  // globals.d.ts), not here: core must not reference orm, which depends on core.

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

  // Defined as getters on process.env by core/init.ts, and substituted into
  // browser bundles by the compiler's `defines`. The client used to redeclare
  // `ImportMeta.env` with its own incompatible shape, which is TS2687/TS2717 —
  // suppressed, like everything else in a .d.ts, by skipLibCheck.
  interface ImportMetaEnv {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly WORKER: boolean
    readonly DEV_WORKER: boolean
    readonly THREAD_WORKER: boolean
    readonly THREAD_ID: string
    readonly TEST: boolean
    readonly MODE: 'production' | 'development' | 'dev-worker' | 'thread-worker'
    // `readonly SERVE_ROOT: string` was declared here. Nothing defines it —
    // not init.ts, not the compiler's `defines` — and nothing reads it, so any
    // code that trusted the declaration would have got `undefined` typed as
    // `string`. The resolved root is `Bakery.serveRoot`; use that.
    /** Compiler define; the only one the browser bundle reads. */
    readonly BAKERY_VERSION: string
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
