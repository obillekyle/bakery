import { getElapsed, log } from '@server/logger'
import { Try } from '@server/utils/common'
import * as core from './core'
import { computeStats } from './endpoints/stats'
import { connectedAnalyticsClients } from './endpoints/websocket'
import { saveAnalyticsData } from './storage-sqlite'
import { Bakery } from '@server/core/bakery'
import { Session } from '@server/session'

const SAVE_THROTTLE_MS = 60000
let lastSaveTime = 0

function throttleSave() {
  const now = Date.now()
  if (now - lastSaveTime >= SAVE_THROTTLE_MS) {
    void saveAnalyticsData(Bakery.cacheDir)
    lastSaveTime = now
  }
}

export let analyticsLoopTimer: ReturnType<typeof setInterval> | null = null

export function startAnalyticsLoop(server: any) {
  if (analyticsLoopTimer) clearInterval(analyticsLoopTimer)
  analyticsLoopTimer = setInterval(async () => {
    try {
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

      throttleSave()

      for (const ws of connectedAnalyticsClients) {
        const opts = ws.data?.data
        if (opts) {
          const stats = computeStats(
            opts.timescale,
            true,
            opts.pagesFilter,
          )
          ws.send(
            JSON.stringify({ status: 200, excludeHistory: true, data: stats }),
          )
        }
      }
    } catch (e) {
      log({
        level: 'trace',
        by: 'analytics',
        msg: `Error in analytics loop: ${String(e)}`,
      })
    }
  }, 1000)
}

export function stopAnalyticsLoop() {
  if (analyticsLoopTimer) {
    clearInterval(analyticsLoopTimer)
    analyticsLoopTimer = null
  }
}
