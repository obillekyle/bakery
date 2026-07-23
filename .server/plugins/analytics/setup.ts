import { Bakery } from '@server/core/bakery'
import { Handler } from '@server/handlers/core/$base'
import { WebSocketHandler } from '@server/handlers/core/$websocket'
import { getElapsed, log } from '@server/logger'
import { Try } from '@server/utils/common'
import { FileSystem as fs } from '@server/utils/fs'
import { response } from '@server/utils/http'
import * as core from './core'
import { BOOT_MAX_ITEMS } from './core'
import * as storageSqlite from './storage-sqlite'
import { handleResetRequest, handleStatsRequest } from './endpoints/stats'
import { AnalyticsWSHandler } from './endpoints/websocket'

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
        // If count is abnormally huge (> 1,000,000) due to previous doubling bug, reset to 1
        pageHitsMap.set(k, count > 1_000_000 ? 1 : count)
      }
    }
  }

  processRawPageHits(pageHitsRaw)
}

import { startAnalyticsLoop, stopAnalyticsLoop } from './loop'

export { startAnalyticsLoop }

class AnalyticsHandler extends Handler {
  static canHandle(path: string) {
    return (
      path === '/_analytics/ping' ||
      path === '/api/_analytics/stats' ||
      path === '/api/_analytics/reset'
    )
  }
  static resolveRoute(path: string): Handler.Route.Info | null {
    if (
      path === '/_analytics/ping' ||
      path === '/api/_analytics/stats' ||
      path === '/api/_analytics/reset'
    ) {
      return new Handler.Route.Info(fs.resolve(''), path)
    }
    return null
  }
  static async handle(
    _path: string,
    req: Request,
  ): Promise<Response | undefined> {
    const res = await handleAnalyticsRequest(req)
    return res || undefined
  }
}



export async function handleAnalyticsRequest(
  req: Request,
): Promise<Response | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (path === '/_analytics/ping')
    return new Response('pong', { headers: { 'Content-Type': 'text/plain' } })
  if (path === '/api/_analytics/reset' && req.method === 'POST')
    return await handleResetRequest(req)
  if (path === '/api/_analytics/stats')
    return await handleStatsRequest(req, url)
  return null
}

export function setupAnalytics() {
  Bakery.handlers.fetch.set(AnalyticsHandler, 110)
  Bakery.handlers.websocket.set(AnalyticsWSHandler)
  void loadAnalyticsData()
  Bakery.onShutdown(async () => {
    stopAnalyticsLoop()
    core.stopPageHitsLogPruner()
    await saveAnalyticsData()
  })
}
