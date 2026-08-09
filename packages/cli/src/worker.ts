import {
  Bakery,
  getHostname,
  hostStore,
} from '@bakery-framework/core/core/bakery'
import {
  initConfig,
  resolveHostConfig,
} from '@bakery-framework/core/core/config'
import { isDevWorker } from '@bakery-framework/core/core/init'
import { resolvePort } from '@bakery-framework/core/core/port'
import type { Handler } from '@bakery-framework/core/handlers'
import { errorMsg, log, serveLog } from '@bakery-framework/core/logger'
import {
  handleRequest,
  handleRequestError,
  processResponse,
  serveWebSocket,
} from '@bakery-framework/core/router'
import { Session } from '@bakery-framework/core/session'
import { runStartupBanner, setupServer } from '@bakery-framework/core/startup'
import { deferredValue, is, Try } from '@bakery-framework/core/utils/common'
import { getClientIp } from '@bakery-framework/core/utils/http'
import { COUNTER_SLOTS } from '@bakery-framework/core/utils/shared-pool'
import { hasORM } from './orm'
import {
  rateLimitSlot,
  retryAfterSeconds,
  sampleRateLimitLog,
} from './rate-limit'
import { runShutdownSequence } from './shutdown'

/**
 * How long a cluster worker holds `Bun.serve` waiting for the master's
 * `INIT_SHARED_POOL` handover. Bounded because a master that never sends the
 * pool must degrade the worker to its local pool, not deadlock it.
 */
const SHARED_POOL_WAIT_MS = 2000

let signalSharedPoolBound: () => void = () => {}
const sharedPoolBound = new Promise<void>(resolve => {
  signalSharedPoolBound = resolve
})

if (typeof self !== 'undefined' && 'addEventListener' in self) {
  self.addEventListener('message', (e: any) => {
    if (e.data?.type === 'INIT_SHARED_POOL' && e.data.buffer) {
      // Rebinds on every send on purpose — a late or repeated handover from
      // the master must still land; resolving the promise twice is a no-op.
      Bakery.sharedPool.bind(e.data.buffer)
      signalSharedPoolBound()
    }

    if (e.data?.type === 'SHUTDOWN') {
      // The cluster master asking for a flush before it calls terminate().
      // Deliberately no process.exit() here: inside a Worker thread that would
      // take the whole cluster down, master included. We flush, we acknowledge,
      // and the master terminates us — or gives up waiting and does it anyway.
      void (async () => {
        Bakery.server?.stop(true)
        await runShutdownSequence()
        Try(() => (self as any).postMessage({ type: 'SHUTDOWN_DONE' }))
      })()
    }
  })
}

try {
  // Memoised no-op on the dev/prod entry paths, which already ran it (and
  // exited there if it threw). A cluster worker is spawned straight into this
  // file and passes through neither entry, so this is its first call — and in
  // PROD a present-but-broken server.config.ts must fail the boot here rather
  // than serve the built-in defaults.
  await initConfig()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

// Skipped entirely when the ORM is not installed — the app has no database and
// asked for none. Note what is *inside* the guard rather than outside it: once
// the ORM is present, a failure to initialise is still fatal, because at that
// point the app does have a database and it does not work.
if (hasORM()) {
  try {
    const { initDB } = await import('@bakery-framework/orm/connection')
    await initDB()
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({
      error: `Database initialization failed: ${errorMsg(error)}`,
    })
    process.exit(1)
  }
}

try {
  await setupServer()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Server setup failed: ${errorMsg(error)}` })
  process.exit(1)
}

if (import.meta.env.THREAD_WORKER) {
  // The master posts INIT_SHARED_POOL immediately after constructing this
  // Worker, but the message lands on a later event-loop turn than an immediate
  // Bun.serve — early requests would hit a worker-local SharedMemoryPool whose
  // counters and rate-limit state bind() then silently discards. So in
  // thread-worker mode only, wait for the handover before serving. Plain
  // prod/dev never set THREAD_WORKER and skip this entirely.
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = await Promise.race([
    sharedPoolBound.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), SHARED_POOL_WAIT_MS)
    }),
  ])
  clearTimeout(timer)
  if (!bound) {
    serveLog.SHARED_POOL_TIMEOUT({ timeout: SHARED_POOL_WAIT_MS })
  }
}

// Same resolver `startup.ts`'s banner and the dev master's URL use, so what we
// bind and what they advertise cannot disagree. It throws on a malformed
// `PORT` rather than handing `Bun.serve` a `NaN` it silently turns into a
// random ephemeral port — which is how `PORT=3000x` used to produce a server
// on 51570 under a banner reading `http://localhost:3000/`.
let PORT: number
try {
  PORT = resolvePort(Bakery.config.port)
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: errorMsg(error) })
  process.exit(1)
}

try {
  Bakery.server = Bun.serve({
    port: PORT,
    hostname: Bakery.config.host,
    reusePort:
      process.platform !== 'win32' && Boolean(import.meta.env.THREAD_WORKER),
    maxRequestBodySize: Bakery.config.maxBodySize,

    async fetch(req) {
      // Parsed once here and attached: `new URL` measures ~1.7us and the
      // router, body parser and proxy all want the same parse.
      const url = new URL(req.url)
      ;(req as any).__parsedUrl = url
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
          const slot = rateLimitSlot(key)
          if (!Bakery.sharedPool.consumeToken(slot, rl.max, rl.refill)) {
            // Sampled — availability under flood: stdout is effectively
            // synchronous on Windows, so a line per rejection replays the
            // flood the limiter just absorbed as a logging flood.
            const suppressed = sampleRateLimitLog(key)
            if (suppressed !== null) {
              if (suppressed > 0) {
                serveLog.RATE_LIMITED_SUPPRESSED({ ip: key, count: suppressed })
              } else {
                serveLog.RATE_LIMITED({ ip: key })
              }
            }
            return new Response('Too Many Requests', {
              status: 429,
              headers: {
                'Retry-After': String(retryAfterSeconds(rl.refill)),
              },
            })
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
  // One `.catch` on the whole chain, not one nested inside the `.then`. The
  // nested form covered `startCompileService` rejecting but left the dynamic
  // `import()` itself unhandled — so a compiler module that failed to load
  // produced an unhandled rejection rather than the WATCHER_ERR line that
  // exists to report exactly that.
  import('@bakery-framework/core/compiler')
    .then(({ startCompileService }) => startCompileService(Bakery.server))
    .catch(e => serveLog.WATCHER_ERR({ error: String(e) }))
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

  // config.onShutdown, framework hooks, plugins, then resource close — see
  // shutdown.ts for why that order. It used to run only the middle two, so an
  // application's `onShutdown` was declared, defaulted to a no-op, and never
  // called. The sequence carries its own deadline.
  await runShutdownSequence()
}

/**
 * `process.exit(0)` lives here, in a `finally`, because `handleShutdown` is
 * async and the signal handler cannot await it: registered directly, its
 * promise was neither awaited nor caught, so a rejection anywhere in teardown
 * became an unhandled rejection *and* skipped the exit — the process kept
 * running with its listener stopped, answering nothing.
 */
function onSignal(signal: string): void {
  void handleShutdown(signal)
    .catch(error => {
      serveLog.UNHANDLED_ERR({ error: `Shutdown failed: ${errorMsg(error)}` })
    })
    .finally(() => process.exit(0))
}

process.on('SIGINT', () => onSignal('SIGINT'))
process.on('SIGTERM', () => onSignal('SIGTERM'))
