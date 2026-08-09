import { errorMsg, log, serveLog } from '@bakery-framework/core/logger'
import { Try } from '@bakery-framework/core/utils/common'

/**
 * How long the master waits for every worker to acknowledge its pre-terminate
 * flush. Bounded on purpose: a wedged worker must delay shutdown, not prevent
 * it.
 */
export const FLUSH_TIMEOUT_MS = 5000

/**
 * The part of `Worker` this module needs. Narrow enough that a test can supply
 * a plain object, which is the only practical way to exercise the timeout — a
 * real Worker that never acknowledges means spawning a real server.
 */
export interface FlushTarget {
  postMessage(message: any): void
  addEventListener(type: 'message', listener: (event: any) => void): void
  removeEventListener(type: 'message', listener: (event: any) => void): void
}

/**
 * Ask every worker to flush, and resolve when they all have — or when
 * `timeoutMs` elapses, whichever comes first.
 *
 * `worker.terminate()` is immediate: a worker's shutdown hooks never run, so
 * the tiered cache's session buffer only reached disk on its own 30s interval.
 * A cluster shutdown could therefore drop up to a full interval of session
 * writes. Resolves `true` when every worker acknowledged, `false` when the
 * deadline won; the caller terminates either way.
 */
export function requestWorkerFlush(
  targets: Iterable<FlushTarget>,
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  const pending = [...targets]
  if (!pending.length) return Promise.resolve(true)

  return new Promise<boolean>(resolve => {
    const listeners = new Map<FlushTarget, (event: any) => void>()
    let remaining = pending.length
    let settled = false

    const finish = (flushed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      for (const [target, listener] of listeners) {
        Try(() => target.removeEventListener('message', listener))
      }
      listeners.clear()
      // `resolve` is the enclosing Promise executor's, not a call that returns
      // one; the rule cannot tell the two apart.
      // biome-ignore lint/nursery/noFloatingPromises: executor resolve, not a promise
      resolve(flushed)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)

    for (const target of pending) {
      const listener = (event: any) => {
        if (event?.data?.type !== 'SHUTDOWN_DONE') return
        Try(() => target.removeEventListener('message', listener))
        listeners.delete(target)
        if (--remaining === 0) finish(true)
      }

      listeners.set(target, listener)
      target.addEventListener('message', listener)
    }

    for (const target of pending) {
      // A worker that already died throws here; that is one fewer acknowledgement
      // and the deadline covers it.
      Try(() => target.postMessage({ type: 'SHUTDOWN' }))
    }
  })
}

export const RESPAWN_BASE_DELAY_MS = 100
export const RESPAWN_MAX_DELAY_MS = 30_000
/** A worker that survives this long is healthy; its failure streak resets. */
export const RESPAWN_RESET_AFTER_MS = 60_000

/**
 * How long the master waits before respawning a crashed worker: exponential
 * backoff, `RESPAWN_BASE_DELAY_MS` doubling per consecutive failure up to
 * `RESPAWN_MAX_DELAY_MS`. A fixed 100ms meant a worker that died during boot
 * (bad DB URL, port conflict) re-ran initDB/setupServer ~10 times a second
 * indefinitely. Pure — delay = f(consecutiveFailures); the caller owns the
 * count and resets it after `RESPAWN_RESET_AFTER_MS` of survival.
 */
export function respawnDelayMs(consecutiveFailures: number): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures))
  // Clamp the exponent before the pow, not the product after it: 2 ** 1024 is
  // already Infinity, and Math.min(Infinity, cap) would mask that.
  const exponent = Math.min(failures - 1, 31)
  return Math.min(RESPAWN_BASE_DELAY_MS * 2 ** exponent, RESPAWN_MAX_DELAY_MS)
}

/** Friendlier names for the platforms the clamp message will actually show. */
const PLATFORM_NAMES: Record<string, string> = {
  win32: 'Windows',
  darwin: 'macOS',
}

export async function handleThreadsMaster(threadCount: number) {
  if (process.platform !== 'linux' && threadCount > 1) {
    // Not just Windows: the multi-worker model needs kernel-level SO_REUSEPORT
    // load balancing, which only Linux provides. On macOS N sockets either
    // fail to bind or never receive balanced traffic — and a bind failure
    // feeds the respawn loop below.
    serveLog.CLUSTER_CLAMPED({
      platform: PLATFORM_NAMES[process.platform] ?? process.platform,
      requested: threadCount,
    })
    threadCount = 1
  }

  let Bakery: any
  try {
    const configMod = await import('@bakery-framework/core/core/config')
    const bakeryMod = await import('@bakery-framework/core')
    await configMod.initConfig()
    Bakery = bakeryMod.Bakery
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({
      error: `Fatal error during master startup: ${errorMsg(error)}`,
    })
    process.exit(1)
  }

  if (threadCount === 1) {
    // Covers both an explicit `--threads 1` and every non-Linux clamp above.
    //
    // THREAD_ID feeds the startup banner; the assignment lands because
    // `core/init.ts` defines it as an accessor on `process.env` (while it was
    // getter-only the assignment threw, and a Try() swallow hid it).
    //
    // THREAD_WORKER is deliberately NOT set. It is the flag that scales caches
    // *down* for N-way memory sharing — HandlerCache 500→50, HandlerMap
    // routeCache 5000→500, the tiered cache's memory tier ÷4, the SQLite page
    // caches ~10x smaller — and a single worker that owns the whole process
    // would get all of that for zero benefit. Setting it here made
    // `--threads 1` strictly worse than plain `bun run serve`; leaving it
    // unset makes this path identical to plain prod.
    ;(process.env as any).THREAD_ID = '0'
    await import('./prod')
    await new Promise(() => {})
    return
  }

  serveLog.STARTING_THREADS({ count: threadCount })

  const workers = new Map<number, Worker>()
  const workerState = new Map<
    number,
    { isTerminated: boolean; consecutiveFailures: number; spawnedAt: number }
  >()

  const spawnWorker = (id: number) => {
    workerState.set(id, {
      isTerminated: false,
      // The streak survives the respawn — that is what makes it a streak.
      consecutiveFailures: workerState.get(id)?.consecutiveFailures ?? 0,
      spawnedAt: Date.now(),
    })

    const worker = new Worker(new URL('./worker.ts', import.meta.url).href, {
      env: {
        ...process.env,
        THREAD_WORKER: '1',
        THREAD_ID: String(id),
      },
    })

    workers.set(id, worker)

    worker.postMessage({
      type: 'INIT_SHARED_POOL',
      buffer: Bakery.sharedPool.buffer,
    })

    worker.addEventListener('error', err => {
      serveLog.UNHANDLED_ERR({
        error: `Worker ${id} error: ${err.message || String(err)}`,
      })
    })

    worker.addEventListener('close', () => {
      const state = workerState.get(id)
      if (state?.isTerminated) return

      // A worker that ran long enough to be called healthy starts a fresh
      // streak; a boot-loop crash keeps doubling.
      const survivedMs = Date.now() - (state?.spawnedAt ?? 0)
      const failures =
        survivedMs >= RESPAWN_RESET_AFTER_MS
          ? 1
          : (state?.consecutiveFailures ?? 0) + 1
      if (state) state.consecutiveFailures = failures

      const delay = respawnDelayMs(failures)
      serveLog.WORKER_RESPAWN({ id, delay, failures })
      workers.delete(id)
      // No give-up ceiling on purpose: a supervisor that stops retrying turns
      // a transient fault into a permanent outage, and choosing that trade-off
      // needs an operator-facing decision (exit code, flag, alerting) this
      // codebase has not made. The 30s cap keeps the retry loop cheap forever.
      setTimeout(() => spawnWorker(id), delay)
    })
  }

  for (let i = 0; i < threadCount; i++) {
    spawnWorker(i)
  }

  async function handleShutdown(signal: string) {
    log({ level: 'info', msg: `Received ${signal}, shutting down cluster...` })
    serveLog.SHUTTING_DOWN()

    // Mark first: a worker that exits while we wait for its flush is exiting
    // because we asked it to, and must not be respawned by the close listener.
    for (const id of workers.keys()) {
      const state = workerState.get(id)
      if (state) state.isTerminated = true
    }

    const flushed = await requestWorkerFlush(workers.values())
    if (!flushed) {
      log({
        level: 'warn',
        msg: `[Cluster] Some workers did not acknowledge the flush within ${FLUSH_TIMEOUT_MS}ms; terminating anyway.`,
      })
    }

    for (const worker of workers.values()) {
      worker.terminate()
    }
    workers.clear()

    // No PluginHooks.onShutdown() here: plugins are set up per-worker, and each
    // worker's runShutdownSequence (triggered by the SHUTDOWN flush above) runs
    // it where the plugin state actually lives. The master never ran setup().

    process.exit(0)
  }

  process.on('SIGINT', () => handleShutdown('SIGINT'))
  process.on('SIGTERM', () => handleShutdown('SIGTERM'))

  await new Promise(() => {})
}
