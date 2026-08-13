import { Bakery } from '@bakery-framework/core/core/bakery'
import { Session } from '@bakery-framework/core/session'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import {
  type AuthorizeFn,
  requestHasCredential,
  response,
} from '@bakery-framework/core/utils/http'
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
 * A request predicate, for apps that gate by their own roles rather than (or
 * as well as) a shared key. Returning `true` admits; throwing or returning
 * anything else denies (convention 2).
 *
 * Re-exported from core rather than declared here: the dashboard and
 * db-explorer plugins need the same type, and three byte-identical copies of a
 * security type drift the way the guards themselves already had.
 */
export type { AuthorizeFn } from '@bakery-framework/core/utils/http'

/**
 * Analytics owns the auth for its endpoints, and the dashboard delegates to
 * it (`isAnalyticsAuthorized`) — the analytics key *is* the dashboard key.
 * Two doors, both fail closed and both off until configured:
 *
 *   - the shared `credential` (`x-analytics-key`, Bearer, or `?analytics-key=`)
 *   - an optional `authorize(req)` predicate for role-based access
 *
 * Neither configured means analytics is closed to everyone, which is the safe
 * default. Note `isAnalyticsAuthorized` is sync-fast on the credential path
 * and only awaits when a predicate is present — the websocket `canHandle`
 * needs a boolean, so a predicate makes the check async there too.
 */
let credential: string | undefined
let authorizeFn: AuthorizeFn | undefined

export function setAnalyticsCredential(value: string | undefined): void {
  credential = value
}

export function setAnalyticsAuthorize(fn: AuthorizeFn | undefined): void {
  authorizeFn = fn
}

export async function isAnalyticsAuthorized(req: Request): Promise<boolean> {
  if (requestHasCredential(req, credential, 'analytics-key')) return true
  if (!authorizeFn) return false
  try {
    return (await authorizeFn(req)) === true
  } catch {
    // A predicate that throws is indeterminate, and indeterminate is denied.
    return false
  }
}

/**
 * The rejection envelope, or `null` when the caller may proceed — a guard
 * returns the rejection rather than throwing (convention 2). It is a
 * `JsonResponseData` and never a `Response`; the router serialises it through
 * the one JSON envelope in `processResponse`. The explicit `<undefined>` says
 * the envelope carries no `data`, which is what makes it assignable into every
 * caller's own payload type.
 */
async function checkAnalyticsAuth(
  req: Request,
): Promise<JsonResponseData<undefined> | null> {
  if (await isAnalyticsAuthorized(req)) return null
  // Armed-but-unauthorised is a 401; nothing configured is a 404 that does
  // not advertise the endpoint at all.
  return credential || authorizeFn
    ? response.json.error<undefined>(401, 'Unauthorized')
    : response.json.error<undefined>(404, 'Not Found')
}

export async function handleResetRequest(
  req: Request,
): Promise<JsonResponseData<undefined>> {
  const authError = await checkAnalyticsAuth(req)
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
  const authError = await checkAnalyticsAuth(req)
  if (authError) return authError

  const timescale = url.searchParams.get('timescale') || '1m'
  const excludeHistory = url.searchParams.get('excludeHistory') === 'true'
  const pagesFilter = url.searchParams.get('pagesFilter') || 'all'

  const stats = computeStats(timescale, excludeHistory, pagesFilter)
  return response.json.success('success', stats)
}
