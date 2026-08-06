export type AnalyticsSnapshot = {
  timestamp: number
  memoryUsed: number | null
  activeLoggers: number | null
  activeSessions: number | null
  routeHits: number | null
  apiHits: number | null
  pageHits: number | null
  uniqueRequests: number | null
  dbHits: number | null
  errorPageHits: number | null
  ping: number | null
}
