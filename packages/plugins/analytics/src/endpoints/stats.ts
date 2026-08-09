import { Bakery } from '@bakery-framework/core/core/bakery'
import { DASHPASS_SESSION_KEY, Session } from '@bakery-framework/core/session'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import * as core from '../core'
import { saveAnalyticsData } from '../storage-sqlite'
import { timescaleToMs } from '../timescale'

function getFilterCutoff(pagesFilter: string): number {
  if (pagesFilter === 'all') return 0
  return Date.now() - (timescaleToMs(pagesFilter) || 0)
}

function buildAggregatedHits(filterCutoff: number): Map<string, number> {
  const aggregated = new Map<string, number>()
  const hasCompleteWindow =
    core.pageHitsLog.length > 0 && core.pageHitsLog[0].timestamp <= filterCutoff

  if (filterCutoff > 0 && hasCompleteWindow) {
    for (let i = core.pageHitsLog.length - 1; i >= 0; i--) {
      const hit = core.pageHitsLog[i]
      if (hit.timestamp < filterCutoff) break
      aggregated.set(hit.path, (aggregated.get(hit.path) || 0) + 1)
    }
    return aggregated
  }

  for (const [k, v] of core.pageHitsMap.entries()) aggregated.set(k, v)
  return aggregated
}

export function computeStats(
  timescale: string,
  excludeHistory: boolean,
  pagesFilter: string,
) {
  const mem = process.memoryUsage()
  const uptime = Math.round(process.uptime())
  const latestHistory = core.getLatestAnalyticsSnapshot()

  const filterCutoff = getFilterCutoff(pagesFilter)
  const aggregated = buildAggregatedHits(filterCutoff)

  const topPagesFiltered = Array.from(aggregated.entries())
    .filter(([page]) => !core.isAssetPath(page))
    .map(([page, hits]) => ({ page, hits }))
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10)

  return {
    uptime: `${uptime}s`,
    uptimeSeconds: uptime,
    pid: process.pid,
    memoryUsed: `${Math.round(mem.rss / 1024 / 1024)} MB`,
    memoryExternal: `${Math.round(mem.external / 1024 / 1024)} MB`,
    bunVersion: Bun.version,
    platform: process.platform,
    arch: process.arch,
    activeLoggers: core.connectedLoggers.size,
    activeSessions: Session.count,
    routeHits: latestHistory.routeHits,
    apiHits: latestHistory.apiHits || 0,
    pageHits: latestHistory.pageHits || 0,
    uniqueRequests: latestHistory.uniqueRequests,
    dbHits: latestHistory.dbHits,
    errorPageHits: latestHistory.errorPageHits,
    ping: latestHistory.ping,
    topPages: topPagesFiltered,
    history: excludeHistory
      ? undefined
      : core.getFilledHistoryForTimescale(timescale),
    latestHistoryPoint: core.getLatestHistoryPoint(timescale),
  }
}

/** The payload `/api/_analytics/stats` puts in the envelope's `data`. */
export type AnalyticsStats = ReturnType<typeof computeStats>

/**
 * True when the caller may read analytics. Fails **closed** when DASHPASS is
 * unset, matching the dashboard's behaviour — this previously returned
 * "authorized" in that case, so the documented "disabled" posture actually
 * exposed process stats and top pages to anyone.
 */
export function isAnalyticsAuthorized(req: Request): boolean {
  if (!process.env.DASHPASS) return false
  return Boolean(req.session?.get(DASHPASS_SESSION_KEY))
}

/**
 * The rejection envelope, or `null` when the caller may proceed — a guard
 * returns the rejection rather than throwing (convention 2). It is a
 * `JsonResponseData` and never a `Response`; the router serialises it through
 * the one JSON envelope in `processResponse`. The explicit `<undefined>` says
 * the envelope carries no `data`, which is what makes it assignable into every
 * caller's own payload type.
 */
function checkDashpassAuth(req: Request): JsonResponseData<undefined> | null {
  if (isAnalyticsAuthorized(req)) return null
  return process.env.DASHPASS
    ? response.json.error<undefined>(401, 'Unauthorized')
    : response.json.error<undefined>(404, 'Not Found')
}

export async function handleResetRequest(
  req: Request,
): Promise<JsonResponseData<undefined>> {
  const authError = checkDashpassAuth(req)
  if (authError) return authError

  core.history1m.length = 0
  core.history1h.length = 0
  core.history1d.length = 0
  core.history7d.length = 0
  core.history30d.length = 0
  core.pageHitsMap.clear()
  core.pageHitsLog.length = 0

  await saveAnalyticsData(Bakery.cacheDir)
  return response.json.success<undefined>('Analytics data reset successfully')
}

export async function handleStatsRequest(
  req: Request,
  url: URL,
): Promise<JsonResponseData<AnalyticsStats | undefined>> {
  const authError = checkDashpassAuth(req)
  if (authError) return authError

  const timescale = url.searchParams.get('timescale') || '1m'
  const excludeHistory = url.searchParams.get('excludeHistory') === 'true'
  const pagesFilter = url.searchParams.get('pagesFilter') || 'all'

  const stats = computeStats(timescale, excludeHistory, pagesFilter)
  return response.json.success('success', stats)
}
