import { Bakery, getHostname, hostStore } from '@server/core/bakery'
import { resolveHostConfig } from '@server/core/config'
import { log } from '@server/logger'
import { deferredValue, is, Try } from '@server/utils/common'
import './core/init'
import { getClientIp } from '@server/utils/http/ip'
import {
  handleRequest,
  handleRequestError,
  processResponse,
  serveWebSocket,
} from './router'
import { Session } from './session'
import { COUNTER_SLOTS } from './utils/shared-pool'
import { runStartupBanner, setupServer } from './startup'
import type { Handler } from './handlers'
import { errorMsg, serveLog } from './logger'

const isDevWorker = Boolean(import.meta.env.DEV_WORKER && import.meta.env.DEV)

if (typeof self !== 'undefined' && 'addEventListener' in self) {
  self.addEventListener('message', (e: any) => {
    if (e.data?.type === 'INIT_SHARED_POOL' && e.data.buffer) {
      Bakery.sharedPool.bind(e.data.buffer)
    }
  })
}

try {
  await setupServer()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Server setup failed: ${errorMsg(error)}` })
  process.exit(1)
}

const PORT = Number(process.env.PORT || Bakery.config.port || 3000)

try {
  Bakery.server = Bun.serve({
    port: PORT,
    hostname: Bakery.config.host,
    reusePort:
      process.platform !== 'win32' && Boolean(import.meta.env.THREAD_WORKER),
    maxRequestBodySize: Bakery.config.maxBodySize,

    async fetch(req) {
      const url = new URL(req.url)
      const hostname = getHostname(req)
      const hostConfig = resolveHostConfig(hostname)

      return hostStore.run({ config: hostConfig, hostname }, async () => {
        const path = url.pathname
        req.startNs = Bun.nanoseconds()
        req.__hostname = hostname
        deferredValue(req, 'session', Session.from)

        const rl = Bakery.config.rateLimit
        if (rl) {
          const key = (rl.keyBy ? rl.keyBy(req) : getClientIp(req)) || hostname
          const slot = Number(Bun.hash(key)) % 1024
          if (!Bakery.sharedPool.consumeToken(slot, rl.max, rl.refill)) {
            serveLog.RATE_LIMITED({ ip: key })
            return new Response('Too Many Requests', { status: 429 })
          }
        }

        Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_REQUESTS, 1)

        const resp: Handler.Response | symbol = await Try.return(
          async function fetchHandler() {
            const res = await handleRequest(req)

            const isResError = res instanceof Response && res.status >= 400
            const isObjError = is.object(res) && 'errorCode' in res

            if (isResError || isObjError) {
              Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_ERRORS, 1)
              return await handleRequestError(path, req, res)
            }
            return res
          },

          async function errorHandler(error) {
            Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_ERRORS, 1)
            serveLog.UNHANDLED_ERR({ error: errorMsg(error) })
            return await handleRequestError(path, req, error)
          },
        )

        const elapsedMs = Math.round((Bun.nanoseconds() - req.startNs) / 1e6)
        Bakery.sharedPool.incrementCounter(
          COUNTER_SLOTS.LATENCY_SUM_MS,
          elapsedMs,
        )
        return processResponse(resp, req)
      })
    },

    websocket: serveWebSocket,

    async error(error: Error, req?: Request): Promise<any> {
      Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_ERRORS, 1)
      serveLog.UNHANDLED_ERR({ error: errorMsg(error) })
      const hostname = req ? getHostname(req) : ''
      const hostConfig = resolveHostConfig(hostname)
      return hostStore.run({ config: hostConfig, hostname }, async () => {
        return await handleRequestError('/', req, error)
      })
    },
  })
} catch (err: any) {
  serveLog.UNHANDLED_ERR({ error: `Failed to start server: ${errorMsg(err)}` })
  process.exit(1)
}

if (isDevWorker) {
  import('./compiler').then(({ startCompileService }) =>
    startCompileService(Bakery.server).catch(e =>
      serveLog.WATCHER_ERR({ error: String(e) }),
    ),
  )
}

try {
  await runStartupBanner()
} catch (e: any) {
  serveLog.UNHANDLED_ERR({ error: `Startup banner failed: ${errorMsg(e)}` })
}

async function handleShutdown(signal: string) {
  log({ level: 'info', msg: `Received ${signal}, shutting down...` })
  serveLog.SHUTTING_DOWN()

  Bakery.server?.stop(true)

  for (const hook of Bakery.shutdownHooks) {
    try {
      await hook()
    } catch (err: any) {
      serveLog.UNHANDLED_ERR({
        error: `Error in shutdown hook: ${errorMsg(err)}`,
      })
    }
  }

  const { PluginHooks } = await import('./core/plugins')
  await PluginHooks.onShutdown()

  process.exit(0)
}

process.on('SIGINT', () => handleShutdown('SIGINT'))
process.on('SIGTERM', () => handleShutdown('SIGTERM'))
