import { networkInterfaces } from 'node:os'
import { Bakery } from './core/bakery'
import { getConfigLoadError } from './core/config'
import { resolvePort } from './core/port'
import {
  ApiErrorHandler,
  ApiHandler,
  DefaultErrorHandler,
  GoogleFontHandler,
  HTMLErrorHandler,
  HTMLHandler,
  ImageHandler,
  LiveReloadHandler,
  MiddlewareHandler,
  NMHandler,
  ProxyHandler,
  PublicHandler,
  StaticHandler,
  TSHandler,
  TSXErrorHandler,
  TSXHandler,
  VirtualAssetHandler,
} from './handlers'
import { log, serveLog } from './logger'
import { match } from './utils/common'
import { DEFAULT_RATE_LIMIT } from './utils/constants'

let pluginSetup: Promise<void> | null = null

/**
 * `PluginHooks.setup()`, exactly once per process.
 *
 * Two call sites legitimately need plugins ready and neither can be dropped.
 * The CLI entries (`cli/dev.ts`, `cli/prod.ts`) must run it before
 * `initImportMap()`, because a plugin's `setup()` may add import-map entries.
 * `setupServer()` must run it too, because a cluster worker is spawned straight
 * into `cli/worker.ts` and never passes through either entry.
 *
 * Calling both meant every non-clustered worker set its plugins up twice.
 * Handler and mount registration is idempotent so that went unnoticed, but the
 * analytics plugin registers a shutdown hook and kicks off `loadAnalyticsData()`
 * from `setup()` — so it got two of each. Memoising the promise (not a boolean)
 * also makes a concurrent second caller await the first run rather than race it.
 */
export function setupPlugins(): Promise<void> {
  pluginSetup ??= (async () => {
    const { PluginHooks } = await import('./core/plugins')
    await PluginHooks.setup()
  })()

  return pluginSetup
}

/**
 * Test seam, in the family of `__setTestConfig` / `__setTestDb`. The memo above
 * is process-wide by design, which is exactly what a test asserting "once"
 * needs to be able to clear between cases.
 */
export function __resetPluginSetup(): void {
  pluginSetup = null
}

export async function setupServer(): Promise<void> {
  if (import.meta.env.DEV) {
    await LiveReloadHandler.init()
    Bakery.handlers.websocket.set(LiveReloadHandler)
  }
  Bakery.handlers.error.set(ApiErrorHandler, 30)
  Bakery.handlers.error.set(TSXErrorHandler, 20)
  Bakery.handlers.error.set(HTMLErrorHandler, 10)
  Bakery.handlers.error.set(DefaultErrorHandler, 0)

  Bakery.handlers.fetch.set(MiddlewareHandler, 100)
  Bakery.handlers.fetch.set(ProxyHandler, 95)
  Bakery.handlers.fetch.set(VirtualAssetHandler, 90)
  Bakery.handlers.fetch.set(GoogleFontHandler, 87)
  Bakery.handlers.fetch.set(ImageHandler, 85)
  Bakery.handlers.fetch.set(PublicHandler, 84)
  Bakery.handlers.fetch.set(NMHandler, 80)
  Bakery.handlers.fetch.set(ApiHandler, 70)
  Bakery.handlers.fetch.set(TSXHandler, 60)
  Bakery.handlers.fetch.set(HTMLHandler, 55)
  Bakery.handlers.fetch.set(TSHandler, 50)
  Bakery.handlers.fetch.set(StaticHandler, 0)

  await setupPlugins()

  await Promise.all([
    Bakery.handlers.fetch.initRoutes(),
    Bakery.handlers.error.initRoutes(),
    Bakery.handlers.websocket.initRoutes(),
  ])
}

export async function runStartupBanner(): Promise<void> {
  const host = Bakery.config.host

  // Ground truth first. The banner's job is to print where the server is
  // listening, and `Bakery.server.port` is what the OS actually gave us —
  // which is the only correct answer under `PORT=0`, and the only *honest*
  // one if the bound port and the requested one ever part company again.
  // `resolvePort` covers the callers that print a banner without a server
  // (a `--sync`-only run, an embedder), and it is the same function
  // `worker.ts` binds with, so the two cannot drift apart.
  const port = Bakery.server?.port || resolvePort(Bakery.config.port)

  const isThreadWorker = import.meta.env.THREAD_WORKER
  if (!isThreadWorker || import.meta.env.THREAD_ID === '0') {
    if (isThreadWorker) {
      serveLog.THREAD_STARTED({ id: import.meta.env.THREAD_ID })
    } else {
      serveLog.SERVER_STARTED()
    }

    const logAllNets = () => {
      serveLog.SERVER_URL({ type: 'Local  ', host: 'localhost', port })
      const nets = networkInterfaces()
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.internal) continue
          if (net.family !== 'IPv4') continue
          serveLog.SERVER_URL({ type: 'Network', host: net.address, port })
        }
      }
    }

    match(host, {
      '0.0.0.0': logAllNets,
      '::': logAllNets,
      [match]: () => serveLog.SERVER_URL({ type: 'Local ', host, port }),
    })

    // Identity, not deep equality: `defaultConfig.rateLimit` *is* this
    // constant, and any user-supplied value replaces the reference. The
    // default limiter 429s load tests and shared-NAT offices with nothing
    // anywhere saying it exists, so this line is its one announcement. An
    // app-configured value prints nothing — their choice, their knowledge.
    if (Bakery.config.rateLimit === DEFAULT_RATE_LIMIT) {
      serveLog.RATE_LIMIT_DEFAULT(DEFAULT_RATE_LIMIT)
    }

    // A broken server.config.ts already logged its import error in DEV, but
    // that scrolls away; the banner is what the developer actually reads.
    if (getConfigLoadError()) {
      serveLog.CONFIG_BROKEN_BANNER()
    }

    log({ by: 'serve', msg: '' })
  }

  const { PluginHooks } = await import('./core/plugins')
  await PluginHooks.onStart(Bakery.server!)
  await Bakery.config.onStart()
}
