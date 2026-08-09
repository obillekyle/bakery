import { Bakery } from '@bakery-framework/core/core/bakery'
import { errorMsg, getElapsed } from '@bakery-framework/core/logger'
import { Session } from '@bakery-framework/core/session'
import { Try } from '@bakery-framework/core/utils/common'
import * as core from './core'
import { computeStats } from './endpoints/stats'
import { connectedAnalyticsClients } from './endpoints/websocket'
import { analyticsLog } from './log'
import { saveAnalyticsData } from './storage-sqlite'

const SAVE_THROTTLE_MS = 60000

/** One sample per second is what every `history1m` window assumes. */
export const ANALYTICS_TICK_MS = 1000

let lastSaveTime = 0

/**
 * Flush at most once per `SAVE_THROTTLE_MS`.
 *
 * The timestamp is stamped when the write *settles*, not when it is
 * dispatched. Stamping first meant a flush that took longer than the window
 * let the next one start on top of it — two writers over the same tables,
 * from a function whose whole job is to be harmless.
 *
 * `finally` rather than the success path: a failed flush that reset nothing
 * would be retried on every following tick, turning one failure into a
 * once-a-second hammer on a database that is already unhappy.
 */
async function throttleSave() {
  if (Date.now() - lastSaveTime < SAVE_THROTTLE_MS) return
  try {
    await saveAnalyticsData(Bakery.cacheDir)
  } finally {
    lastSaveTime = Date.now()
  }
}

async function runAnalyticsTick(server: any) {
  const activeLoggersCount = core.connectedLoggers.size
  const pingStart = Bun.nanoseconds()
  const pingVal = await Try.return(async function getPing() {
    const res = await server.fetch(`http://localhost/_analytics/ping`)
    return res.status === 200 ? getElapsed(pingStart) : res.status
  }, 0)

  const mem = process.memoryUsage()
  core.pushAnalyticsSnapshot({
    timestamp: Date.now(),
    memoryUsed: Math.round(mem.rss / 1024 / 1024),
    activeLoggers: activeLoggersCount,
    activeSessions: Session.count,
    ping: pingVal,
  })

  // Awaited, not floated: a rejected flush used to escape this tick entirely
  // and land nowhere.
  await throttleSave()

  for (const ws of connectedAnalyticsClients) {
    const opts = ws.data?.data
    if (opts) {
      const stats = computeStats(opts.timescale, true, opts.pagesFilter)
      ws.send(
        JSON.stringify({ status: 200, excludeHistory: true, data: stats }),
      )
    }
  }
}

export let analyticsLoopTimer: ReturnType<typeof setTimeout> | null = null

/** False between `stopAnalyticsLoop()` and the next start; gates the re-arm. */
let loopRunning = false

/**
 * Sample the server once every `intervalMs`.
 *
 * A self-rescheduling `setTimeout`, not `setInterval`. The tick body makes a
 * full round trip through the server — `MiddlewareHandler`, so `onRequest` and
 * every app middleware — plus a `Session.count`, which is a SQLite `COUNT(*)`.
 * `setInterval` does not wait for an async body, so once p50 exceeded one
 * second the ticks overlapped and the in-flight pings accumulated, each adding
 * load that lengthened the next: positive feedback, from the telemetry.
 *
 * The overlap was not only a load problem. `pushAnalyticsSnapshot` zeroes the
 * per-second counters at the end of a tick, so a re-entrant call double-advanced
 * the hourly accumulator and emptied the counters belonging to the tick still
 * in flight — drifting the 60-snapshot aggregation boundary off a real hour.
 * Re-arming in `finally` makes the overlap structurally impossible rather than
 * merely unlikely, so neither failure can come back.
 *
 * `intervalMs` is a parameter so a test can drive the scheduler in
 * milliseconds instead of minutes; nothing in the framework passes it.
 */
export function startAnalyticsLoop(
  server: any,
  intervalMs = ANALYTICS_TICK_MS,
) {
  stopAnalyticsLoop()
  loopRunning = true

  // One throttle window from now, not from the epoch. `lastSaveTime` starting
  // at 0 made the very first tick flush a store that had accumulated exactly
  // one sample, and put a SQLite write on the boot path.
  lastSaveTime = Date.now()

  const tick = async () => {
    try {
      await runAnalyticsTick(server)
    } catch (e) {
      analyticsLog.LOOP_ERR({ error: errorMsg(e) })
    } finally {
      // The re-arm lives here and only here: the next tick is scheduled once
      // this one has fully settled, so two can never be in flight at once.
      // A tick that was stopped mid-flight must not resurrect the loop.
      if (loopRunning) analyticsLoopTimer = setTimeout(tick, intervalMs)
    }
  }

  analyticsLoopTimer = setTimeout(tick, intervalMs)
}

export function stopAnalyticsLoop() {
  loopRunning = false
  if (analyticsLoopTimer) {
    clearTimeout(analyticsLoopTimer)
    analyticsLoopTimer = null
  }
}
