import { networkInterfaces } from 'node:os'
import { Bakery } from '@server/core/bakery'
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
  StaticHandler,
  TSHandler,
  TSXErrorHandler,
  TSXHandler,
  VirtualAssetHandler,
} from '@server/handlers'
import { Logger, log } from '@server/logger'
import { match } from '@server/utils/common'
import { serveLog } from './logger'

export async function setupServer(): Promise<void> {
  const { PluginHooks } = await import('./core/plugins')

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
  Bakery.handlers.fetch.set(NMHandler, 80)
  Bakery.handlers.fetch.set(ApiHandler, 70)
  Bakery.handlers.fetch.set(TSXHandler, 60)
  Bakery.handlers.fetch.set(HTMLHandler, 55)
  Bakery.handlers.fetch.set(TSHandler, 50)
  Bakery.handlers.fetch.set(StaticHandler, 0)

  await PluginHooks.setup()

  await Promise.all([
    Bakery.handlers.fetch.initRoutes(),
    Bakery.handlers.error.initRoutes(),
    Bakery.handlers.websocket.initRoutes(),
  ])
}

export async function runStartupBanner(): Promise<void> {
  const host = Bakery.config.host
  let port = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : Bakery.config.port

  port ||= Bakery.server?.port || 0

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

    log({ by: 'serve', msg: '' })
  }

  const { PluginHooks } = await import('./core/plugins')
  await PluginHooks.onStart(Bakery.server!)
  await Bakery.config.onStart()
}
