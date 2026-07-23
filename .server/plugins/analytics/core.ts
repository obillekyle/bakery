import type { AnalyticsSnapshot } from './types'

export const RETENTION_MS = 30 * 24 * 3600 * 1000
export const BOOT_MAX_ITEMS = 5000
export const HARD_CAP = 50_000

export const history1m: AnalyticsSnapshot[] = []
export const history1h: AnalyticsSnapshot[] = []
export const history1d: AnalyticsSnapshot[] = []
export const history7d: AnalyticsSnapshot[] = []
export const history30d: AnalyticsSnapshot[] = []

export const pageHitsLog: { timestamp: number; path: string }[] = []
export const pageHitsMap = new Map<string, number>()
export const connectedLoggers = new Set<any>()

type TempAccumulator = {
  count: number
  memoryUsed: number
  activeLoggers: number
  activeSessions: number
  routeHits: number
  apiHits: number
  pageHits: number
  uniqueRequests: number
  dbHits: number
  errorPageHits: number
  ping: number
}

function createAccumulator(): TempAccumulator {
  return {
    count: 0,
    memoryUsed: 0,
    activeLoggers: 0,
    activeSessions: 0,
    routeHits: 0,
    apiHits: 0,
    pageHits: 0,
    uniqueRequests: 0,
    dbHits: 0,
    errorPageHits: 0,
    ping: 0,
  }
}

const temp1h = createAccumulator()
const temp1d = createAccumulator()
const temp7d = createAccumulator()
const temp30d = createAccumulator()

let routeHitsThisSecond = 0
let apiHitsThisSecond = 0
let pageHitsThisSecond = 0
const uniqueRequestsThisSecond = new Set<string>()
let dbHitsThisSecond = 0
let errorPageHitsThisSecond = 0

function prunePageHitsLog(now: number) {
  let i = 0
  while (
    i < pageHitsLog.length &&
    pageHitsLog[i].timestamp < now - RETENTION_MS
  )
    i++
  if (i > 0) {
    for (let j = 0; j < i; j++) {
      const p = pageHitsLog[j].path
      const c = pageHitsMap.get(p)
      if (c === 1) pageHitsMap.delete(p)
      else if (c) pageHitsMap.set(p, c - 1)
    }
    pageHitsLog.splice(0, i)
  }

  if (pageHitsLog.length > HARD_CAP) {
    const excess = pageHitsLog.length - HARD_CAP
    for (let j = 0; j < excess; j++) {
      const p = pageHitsLog[j].path
      const c = pageHitsMap.get(p)
      if (c === 1) pageHitsMap.delete(p)
      else if (c) pageHitsMap.set(p, c - 1)
    }
    pageHitsLog.splice(0, excess)
  }
}

let _pageHitsLogPruneTimer: ReturnType<typeof setInterval> | null = null
export function ensurePageHitsLogPruner() {
  if (_pageHitsLogPruneTimer !== null) return
  _pageHitsLogPruneTimer = setInterval(() => {
    try {
      prunePageHitsLog(Date.now())
    } catch (_e) {
      // swallow errors; pruner is best-effort
    }
  }, 60_000)
}

export function stopPageHitsLogPruner() {
  if (_pageHitsLogPruneTimer !== null) {
    clearInterval(_pageHitsLogPruneTimer)
    _pageHitsLogPruneTimer = null
  }
}

function accumulate(temp: TempAccumulator, s: AnalyticsSnapshot) {
  temp.count++
  temp.memoryUsed += s.memoryUsed || 0
  temp.activeLoggers += s.activeLoggers || 0
  temp.activeSessions += s.activeSessions || 0
  temp.routeHits += s.routeHits || 0
  temp.apiHits += s.apiHits || 0
  temp.pageHits += s.pageHits || 0
  temp.uniqueRequests += s.uniqueRequests || 0
  temp.dbHits += s.dbHits || 0
  temp.errorPageHits += s.errorPageHits || 0
  temp.ping += s.ping || 0
}

function finalizeAggregation(
  temp: TempAccumulator,
  timestamp: number,
): AnalyticsSnapshot {
  const count = temp.count || 1
  const result: AnalyticsSnapshot = {
    timestamp,
    memoryUsed: Math.round(temp.memoryUsed / count),
    activeLoggers: Math.round(temp.activeLoggers / count),
    activeSessions: Math.round(temp.activeSessions / count),
    routeHits: temp.routeHits,
    apiHits: temp.apiHits,
    pageHits: temp.pageHits,
    uniqueRequests: temp.uniqueRequests,
    dbHits: temp.dbHits,
    errorPageHits: temp.errorPageHits,
    ping: Math.round(temp.ping / count),
  }
  Object.assign(temp, createAccumulator())
  return result
}

function loadAccumulator(target: TempAccumulator, loaded: any) {
  if (!loaded) return
  if (Array.isArray(loaded)) {
    Object.assign(target, createAccumulator())
    target.count = loaded.length
    for (const s of loaded) {
      target.memoryUsed += s.memoryUsed || 0
      target.activeLoggers += s.activeLoggers || 0
      target.activeSessions += s.activeSessions || 0
      target.routeHits += s.routeHits || 0
      target.apiHits += s.apiHits || 0
      target.pageHits += s.pageHits || 0
      target.uniqueRequests += s.uniqueRequests || 0
      target.dbHits += s.dbHits || 0
      target.errorPageHits += s.errorPageHits || 0
      target.ping += s.ping || 0
    }
  } else if (typeof loaded === 'object') {
    Object.assign(target, loaded)
  }
}

export function isAssetPath(path: string): boolean {
  if (!path || typeof path !== 'string') return true
  if (path.startsWith('/_')) return true
  return /\.(css|js|mjs|cjs|ts|tsx|jsx|vue|json|map|png|jpg|jpeg|webp|gif|svg|ico|bmp|woff|woff2|ttf|eot|txt|xml|webmanifest)$/i.test(
    path,
  )
}

export function recordRouteHit(method: string, path: string, search = '') {
  routeHitsThisSecond += 1
  if (path.startsWith('/api/')) {
    apiHitsThisSecond += 1
  } else if (!isAssetPath(path)) {
    pageHitsThisSecond += 1
    pageHitsLog.push({ timestamp: Date.now(), path })
    ensurePageHitsLogPruner()
    pageHitsMap.set(path, (pageHitsMap.get(path) || 0) + 1)
  }
  uniqueRequestsThisSecond.add(`${method} ${path}${search}`)
}

export function recordDbHit() {
  dbHitsThisSecond += 1
}

export function recordErrorPageHit() {
  errorPageHitsThisSecond += 1
}

export function pushAnalyticsSnapshot(snapshot: {
  timestamp: number
  memoryUsed: number
  activeLoggers: number
  activeSessions: number
  ping: number
}) {
  const fullSnapshot: AnalyticsSnapshot = {
    ...snapshot,
    routeHits: routeHitsThisSecond,
    apiHits: apiHitsThisSecond,
    pageHits: pageHitsThisSecond,
    uniqueRequests: uniqueRequestsThisSecond.size,
    dbHits: dbHitsThisSecond,
    errorPageHits: errorPageHitsThisSecond,
  }

  history1m.push(fullSnapshot)
  if (history1m.length > 60) history1m.shift()

  accumulate(temp1h, fullSnapshot)
  accumulate(temp1d, fullSnapshot)
  accumulate(temp7d, fullSnapshot)
  accumulate(temp30d, fullSnapshot)

  if (temp1h.count >= 60) {
    history1h.push(finalizeAggregation(temp1h, fullSnapshot.timestamp))
    if (history1h.length > 60) history1h.shift()
  }
  if (temp1d.count >= 1800) {
    history1d.push(finalizeAggregation(temp1d, fullSnapshot.timestamp))
    if (history1d.length > 48) history1d.shift()
  }
  if (temp7d.count >= 21600) {
    history7d.push(finalizeAggregation(temp7d, fullSnapshot.timestamp))
    if (history7d.length > 28) history7d.shift()
  }
  if (temp30d.count >= 86400) {
    history30d.push(finalizeAggregation(temp30d, fullSnapshot.timestamp))
    if (history30d.length > 30) history30d.shift()
  }

  routeHitsThisSecond = 0
  apiHitsThisSecond = 0
  pageHitsThisSecond = 0
  uniqueRequestsThisSecond.clear()
  dbHitsThisSecond = 0
  errorPageHitsThisSecond = 0
}

export function getLatestAnalyticsSnapshot() {
  return (
    history1m[history1m.length - 1] || {
      routeHits: 0,
      apiHits: 0,
      pageHits: 0,
      uniqueRequests: 0,
      dbHits: 0,
      errorPageHits: 0,
      ping: 0,
    }
  )
}

export function getHistoryLimitForTimescale(timescale: string): number {
  switch (timescale) {
    case '30d':
      return 30
    case '7d':
      return 28
    case '1d':
      return 48
    case '1h':
      return 60
    default:
      return 60
  }
}

export function getHistoryForTimescale(timescale: string): AnalyticsSnapshot[] {
  switch (timescale) {
    case '30d':
      return history30d
    case '7d':
      return history7d
    case '1d':
      return history1d
    case '1h':
      return history1h
    default:
      return history1m
  }
}

export function getLatestHistoryPoint(
  timescale: string,
): AnalyticsSnapshot | null {
  const history = getHistoryForTimescale(timescale)
  return history[history.length - 1] || null
}

export function getFilledHistoryForTimescale(
  timescale: string,
): AnalyticsSnapshot[] {
  const raw = getHistoryForTimescale(timescale)
  if (raw.length <= 1) return [...raw]

  let interval = 1000
  switch (timescale) {
    case '30d':
      interval = 86400000
      break
    case '7d':
      interval = 21600000
      break
    case '1d':
      interval = 1800000
      break
    case '1h':
      interval = 60000
      break
    default:
      interval = 1000
      break
  }

  const limit = getHistoryLimitForTimescale(timescale)
  const filled: AnalyticsSnapshot[] = []
  filled.push({ ...raw[0] })

  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1]
    const curr = raw[i]
    const diff = curr.timestamp - prev.timestamp

    if (diff > interval * 1.5) {
      const startT = Math.max(
        prev.timestamp + interval,
        curr.timestamp - limit * interval,
      )
      let t = startT
      while (t < curr.timestamp - interval * 0.5) {
        filled.push({
          timestamp: t,
          memoryUsed: null,
          activeLoggers: null,
          activeSessions: null,
          routeHits: null,
          apiHits: null,
          pageHits: null,
          uniqueRequests: null,
          dbHits: null,
          errorPageHits: null,
          ping: null,
        })
        t += interval
      }
    }
    filled.push({ ...curr })
  }

  if (filled.length > limit) return filled.slice(-limit)
  return filled
}

export function loadTemps(loaded: any) {
  if (!loaded) return
  if (loaded.temp1h) loadAccumulator(temp1h, loaded.temp1h)
  if (loaded.temp1d) loadAccumulator(temp1d, loaded.temp1d)
  if (loaded.temp7d) loadAccumulator(temp7d, loaded.temp7d)
  if (loaded.temp30d) loadAccumulator(temp30d, loaded.temp30d)
}
