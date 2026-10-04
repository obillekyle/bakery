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
import { deferredValue, Try } from '@bakery-framework/core/utils/common'
import { parsedUrl } from '@bakery-framework/core/utils/http'
import { COUNTER_SLOTS } from '@bakery-framework/core/utils/shared-pool'
import { hasORM } from './orm'
import {
  answeredAsAsset,
  bucketKey,
  checkRateLimits,
  compileRateLimit,
  isErrorResult,
  type RateLimitConfig,
  rateLimitBucket,
  rateLimitKey,
  tooManyRequests,
} from './pipeline'
import {
  assetKey,
  forgetAsset,
  isProvenAsset,
  proveAsset,
  rateLimitSlot,
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
      // Rebinds on every send on purpose: a late or repeated handover from
      // the master must still land; resolving the promise twice is a no-op.
      Bakery.sharedPool.bind(e.data.buffer)
      signalSharedPoolBound()
    }

    if (e.data?.type === 'SHUTDOWN') {
      // The cluster master asking for a flush before it calls terminate().
      // Deliberately no process.exit() here: inside a Worker thread that would
      // take the whole cluster down, master included. We flush, we acknowledge,
      // and the master terminates us, or gives up waiting and does it anyway.
      void (async () => {
        Bakery.server?.stop(true)
        await runShutdownSequence()
        Try(() => (self as any).postMessage({ type: 'SHUTDOWN_DONE' }))
      })()
    }
  })
}

try {
  // Memoized no-op on the dev/prod entry paths, which already ran it (and
  // exited there if it threw). A cluster worker is spawned straight into this
  // file and passes through neither entry, so this is its first call, and in
  // PROD a present-but-broken server.config.ts must fail the boot here rather
  // than serve the built-in defaults.
  await initConfig()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

// Skipped entirely when the ORM is not installed. The app has no database and
// asked for none. Note what is *inside* the guard rather than outside it: once
// the ORM is present, a failure to initialize is still fatal, because at that
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
  // Bun.serve. Early requests would hit a worker-local SharedMemoryPool whose
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
// random ephemeral port, which is how `PORT=3000x` used to produce a server
// on 51570 under a banner reading `http://localhost:3000/`.
let PORT: number
try {
  PORT = resolvePort(Bakery.config.port)
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: errorMsg(error) })
  process.exit(1)
}

/**
 * What the limiter did with a request, for `settleRequest` to finish once the
 * response is known: the request's asset key, whether it skipped the bucket
 * as a proven asset, and otherwise the slot it borrowed a token from.
 */
type RateLimitTicket = {
  asset: bigint
  skipped: boolean
  slot: number
  refill: number
}

/**
 * Let a request in, or answer it 429.
 *
 * A URL some handler has already served as an asset skips the bucket (see
 * `Handler.isAsset`). Anything else borrows a token before it is routed: the
 * charge cannot wait for the response, because admitting first and charging
 * afterwards lets a burst of any size through at once.
 */
function admitRequest(
  rl: RateLimitConfig,
  path: string,
  search: string,
  req: Request,
  hostname: string,
): RateLimitTicket | Response {
  const asset = assetKey(path, search, req)
  if (isProvenAsset(asset)) return { asset, skipped: true, slot: -1, refill: 0 }

  const bucket = rateLimitBucket(compileRateLimit(rl), path)
  const key = rateLimitKey(bucket, req, hostname)
  const slot = rateLimitSlot(bucketKey(bucket, key))
  if (Bakery.sharedPool.consumeToken(slot, bucket.max, bucket.refill)) {
    return { asset, skipped: false, slot, refill: bucket.refill }
  }

  // Sampled: availability under flood: stdout is effectively synchronous on
  // Windows, so a line per rejection replays the flood the limiter just
  // absorbed as a logging flood. Sampled per bucket, so a client limited at
  // sign-in and elsewhere gets a line for each.
  const suppressed = sampleRateLimitLog(bucketKey(bucket, key))
  if (suppressed !== null) {
    const prefix = bucket.prefix
    if (prefix && suppressed > 0) {
      serveLog.RATE_LIMITED_ROUTE_SUPPRESSED({
        ip: key,
        prefix,
        count: suppressed,
      })
    } else if (prefix) {
      serveLog.RATE_LIMITED_ROUTE({ ip: key, prefix })
    } else if (suppressed > 0) {
      serveLog.RATE_LIMITED_SUPPRESSED({ ip: key, count: suppressed })
    } else {
      serveLog.RATE_LIMITED({ ip: key })
    }
  }
  return tooManyRequests(bucket.refill)
}

/**
 * Settle the limiter's account with a request once its response is ready.
 *
 * Served as an asset: its URL is remembered, and a borrowed token goes back.
 * Skipped the bucket as a proven asset and then was not one (a deleted file,
 * a refused range, a guard that said no): the URL is forgotten and the
 * request is charged after the fact, so a URL that has started failing costs
 * what any other request costs. Anything else keeps the token it spent.
 */
function settleRequest(
  ticket: RateLimitTicket,
  rl: RateLimitConfig,
  path: string,
  req: Request,
  hostname: string,
  res: Response | undefined,
): void {
  const handler = hostStore.getStore()?.handler
  if (answeredAsAsset(handler, path, req, res?.status ?? 0)) {
    proveAsset(ticket.asset)
    if (!ticket.skipped)
      Bakery.sharedPool.refundToken(ticket.slot, ticket.refill)
    return
  }
  if (!ticket.skipped) return

  forgetAsset(ticket.asset)
  const bucket = rateLimitBucket(compileRateLimit(rl), path)
  const key = rateLimitKey(bucket, req, hostname)
  Bakery.sharedPool.consumeToken(
    rateLimitSlot(bucketKey(bucket, key)),
    bucket.max,
    bucket.refill,
  )
}

try {
  // Before anything binds: a rate limit that cannot mean anything (a refill
  // of 0, a prefix without its slash) stops the boot here, naming the field,
  // in the catch below.
  checkRateLimits(Bakery.config)

  Bakery.server = Bun.serve({
    port: PORT,
    hostname: Bakery.config.host,
    reusePort:
      process.platform !== 'win32' && Boolean(import.meta.env.THREAD_WORKER),
    maxRequestBodySize: Bakery.config.maxBodySize,

    async fetch(req) {
      // Memoized for the lifetime of the request: the router, body parser and
      // proxy all want the same parse, and every one of them asks for it the
      // same way.
      const url = parsedUrl(req)
      const hostname = getHostname(req)
      const hostConfig = resolveHostConfig(hostname)

      return hostStore.run({ config: hostConfig, hostname, req }, async () => {
        const path = url.pathname
        req.startNs = Bun.nanoseconds()
        req.__hostname = hostname
        deferredValue(req, 'session', Session.from)

        const rl = Bakery.config.rateLimit
        let ticket: RateLimitTicket | null = null
        if (rl) {
          const admitted = admitRequest(rl, path, url.search, req, hostname)
          if (admitted instanceof Response) return admitted
          ticket = admitted
        }

        Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_REQUESTS, 1)

        const resp: Handler.Response | symbol = await Try.return(
          async function fetchHandler() {
            const res = await handleRequest(req)

            if (isErrorResult(res)) {
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
        const res = await processResponse(resp, req)
        if (rl && ticket) settleRequest(ticket, rl, path, req, hostname, res)
        return res
      })
    },

    websocket: serveWebSocket,

    async error(error: Error, req?: Request): Promise<any> {
      Bakery.sharedPool.incrementCounter(COUNTER_SLOTS.TOTAL_ERRORS, 1)
      serveLog.UNHANDLED_ERR({ error: errorMsg(error) })
      const hostname = req ? getHostname(req) : ''
      const hostConfig = resolveHostConfig(hostname)
      return hostStore.run({ config: hostConfig, hostname, req }, async () => {
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
  // `import()` itself unhandled, so a compiler module that failed to load
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

  // config.onShutdown, framework hooks, plugins, then resource close. See
  // shutdown.ts for why that order. It used to run only the middle two, so an
  // application's `onShutdown` was declared, defaulted to a no-op, and never
  // called. The sequence carries its own deadline.
  await runShutdownSequence()
}

/**
 * `process.exit(0)` lives here, in a `finally`, because `handleShutdown` is
 * async and the signal handler cannot await it: registered directly, its
 * promise was neither awaited nor caught, so a rejection anywhere in teardown
 * became an unhandled rejection *and* skipped the exit, the process kept
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
