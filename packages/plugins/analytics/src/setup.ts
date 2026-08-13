import { Bakery } from '@bakery-framework/core/core/bakery'
import { Handler } from '@bakery-framework/core/handlers'
import {
  type PluginRouteTable,
  routeTable,
} from '@bakery-framework/core/plugins'
import { FileSystem as fs } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import * as core from './core'
import { BOOT_MAX_ITEMS } from './core'
import type { AnalyticsStats } from './endpoints/stats'
import {
  type AuthorizeFn,
  handleResetRequest,
  handleStatsRequest,
  setAnalyticsAuthorize,
  setAnalyticsCredential,
} from './endpoints/stats'
import { AnalyticsWSHandler } from './endpoints/websocket'
import * as storageSqlite from './storage-sqlite'

const PAGE_HITS_BOOT_WINDOW_MS = 24 * 3600 * 1000

export const pageHitsLog = core.pageHitsLog
export const pageHitsMap = core.pageHitsMap
export const history1m = core.history1m
export const history1h = core.history1h
export const history1d = core.history1d
export const history7d = core.history7d
export const history30d = core.history30d

export const recordRouteHit = core.recordRouteHit
export const recordDbHit = core.recordDbHit
export const recordErrorPageHit = core.recordErrorPageHit
export const pushAnalyticsSnapshot = core.pushAnalyticsSnapshot
export const getLatestAnalyticsSnapshot = core.getLatestAnalyticsSnapshot
export const getHistoryLimitForTimescale = core.getHistoryLimitForTimescale
export const getFilledHistoryForTimescale = core.getFilledHistoryForTimescale
export const getHistoryForTimescale = core.getHistoryForTimescale
export const getLatestHistoryPoint = core.getLatestHistoryPoint

async function saveAnalyticsData() {
  const cacheBase = Bakery.cacheDir
  await storageSqlite.saveAnalyticsData(cacheBase)
}

function syncHistoryArrays(data: any) {
  const syncArr = (source: any[], target: any[]) => {
    if (source) {
      target.length = 0
      target.push(...source)
    }
  }
  syncArr(data.history1m, core.history1m)
  syncArr(data.history1h, core.history1h)
  syncArr(data.history1d, core.history1d)
  syncArr(data.history7d, core.history7d)
  syncArr(data.history30d, core.history30d)
}

function processRawPageHits(pageHitsRaw: any) {
  if (!Array.isArray(pageHitsRaw) || pageHitsRaw.length === 0) return

  const minTs = Date.now() - PAGE_HITS_BOOT_WINDOW_MS
  const list = pageHitsRaw
    .map((e: any) => ({
      timestamp: Number(e?.timestamp) || 0,
      path: e?.path,
    }))
    .filter(
      (e: any) =>
        Number.isFinite(e.timestamp) &&
        typeof e.path === 'string' &&
        e.path.length > 0 &&
        !core.isAssetPath(e.path) &&
        e.timestamp >= minTs,
    )
    .slice(-BOOT_MAX_ITEMS)

  pageHitsLog.length = 0
  pageHitsLog.push(...list)
}

async function loadAnalyticsData() {
  const cacheBase = Bakery.cacheDir
  const { coreData, pageHitsRaw } =
    await storageSqlite.loadAnalyticsData(cacheBase)

  const data = coreData || {}
  if (!coreData && !pageHitsRaw) return

  syncHistoryArrays(data)

  if (data.temp1h || data.temp1d || data.temp7d || data.temp30d) {
    core.loadTemps(data)
  }

  if (data.pageHits && Array.isArray(data.pageHits)) {
    pageHitsMap.clear()
    for (const [k, v] of data.pageHits) {
      if (!core.isAssetPath(k)) {
        const count = typeof v === 'number' && Number.isFinite(v) ? v : 0

        pageHitsMap.set(k, count > 1_000_000 ? 1 : count)
      }
    }
  }

  processRawPageHits(pageHitsRaw)
}

import { startAnalyticsLoop, stopAnalyticsLoop } from './loop'

export { startAnalyticsLoop }

/**
 * The three paths this plugin claims, written once.
 *
 * `canHandle` and `resolveRoute` have to agree exactly: the handler sits at
 * priority 110, above every content handler, so a path only `canHandle` knows
 * about is claimed and then unroutable, and one only `resolveRoute` knows about
 * is never reached. They held two verbatim copies of this list. The dashboard
 * plugin keeps the same rule in `isDashboardPath`, over namespaces rather than
 * exact paths.
 *
 * Exact matches, not prefixes — `/_analytics/pingback` belongs to the app.
 */
const ANALYTICS_PATHS = new Set([
  '/_analytics/ping',
  '/api/_analytics/stats',
  '/api/_analytics/reset',
])

function isAnalyticsPath(path: string): boolean {
  return ANALYTICS_PATHS.has(path)
}

class AnalyticsHandler extends Handler {
  static canHandle(path: string) {
    return isAnalyticsPath(path)
  }
  static resolveRoute(path: string): Handler.Route.Info | null {
    if (isAnalyticsPath(path)) {
      return new Handler.Route.Info(fs.resolve(''), path)
    }
    return null
  }
  static async handle(
    _path: string,
    req: Request,
  ): Promise<AnalyticsResponse | undefined> {
    const res = await handleAnalyticsRequest(req)
    return res || undefined
  }
}

/**
 * Auth stays inside each endpoint (`handleStatsRequest` / `handleResetRequest`
 * fail closed on their own) — this table only replaces the path/method chain.
 *
 * `satisfies` rather than an annotation: it checks the table against
 * `PluginRouteTable` while keeping the literal type, so `routeTable` can carry
 * each endpoint's real return type through to `handleAnalyticsRequest`.
 */
const analyticsRoutes = routeTable({
  '/_analytics/ping': () => response.text('pong'),
  'POST /api/_analytics/reset': req => handleResetRequest(req),
  '/api/_analytics/stats': (req, url) => handleStatsRequest(req, url),
} satisfies PluginRouteTable)

/**
 * `/_analytics/ping` is a plain `Response`; the two `/api/` endpoints return
 * the JSON envelope, which the router serialises in `processResponse`. Spelling
 * the union out here means adding a route that returns something else is a
 * compile error rather than a silent widening.
 */
export type AnalyticsResponse =
  | Response
  | JsonResponseData<AnalyticsStats | undefined>

export function handleAnalyticsRequest(
  req: Request,
): Promise<AnalyticsResponse | null> {
  return analyticsRoutes(req)
}

let registered = false

export interface AnalyticsAuthOptions {
  credential?: string
  authorize?: AuthorizeFn
}

/**
 * The auth half of `setupAnalytics`, split out from the once-only half.
 *
 * Auth is (re)applied on every call — last config wins — so the dashboard
 * bringing analytics up with the shared key overrides a bare
 * `analyticsPlugin()`, whichever order they registered in.
 *
 * "Whichever order" is what the `!== undefined` buys, and it is the whole
 * reason each option is applied conditionally rather than assigned straight
 * through. Both plugins forward their options here and an application
 * configures whichever of the two it thinks of as the console, so under a
 * plain assignment the answer would depend on registration order: in
 * `apps/example`, `analyticsPlugin({ credential })` runs after
 * `dashboardPlugin({ authorize })` and would have wiped the predicate,
 * shutting the console it was registered to open. A call that carries a value
 * wins; a bare call is a no-op against auth rather than a silent disarm.
 * Turning a door off means not registering the plugin, or passing the empty
 * string — never omitting the option.
 *
 * It is separate, and exported, because `setupAnalytics` cannot be called from
 * a test: it also registers two handlers, installs a shutdown hook and kicks
 * off a data load, none of them restorable (convention 9).
 */
export function applyAnalyticsAuth(options: AnalyticsAuthOptions): void {
  if (options.credential !== undefined) {
    setAnalyticsCredential(options.credential)
  }
  if (options.authorize !== undefined) setAnalyticsAuthorize(options.authorize)
}

export function setupAnalytics(options: AnalyticsAuthOptions = {}) {
  applyAnalyticsAuth(options)

  // The rest runs once. Analytics is now a hard dependency of the dashboard,
  // so both may set it up in one process; the handler registrations are
  // idempotent but the shutdown hook and data load are not, and a doubled
  // load would race two reads of the same file.
  if (registered) return
  registered = true

  Bakery.handlers.fetch.set(AnalyticsHandler, 110)
  Bakery.handlers.websocket.set(AnalyticsWSHandler)
  void loadAnalyticsData()
  Bakery.onShutdown(async () => {
    stopAnalyticsLoop()
    core.stopPageHitsLogPruner()
    await saveAnalyticsData()
  })
}
