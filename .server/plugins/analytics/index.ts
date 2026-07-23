import { definePlugin } from '@plugins/types'
import { recordErrorPageHit, recordRouteHit } from './core'

export {
  connectedLoggers,
  history1d,
  history1h,
  history1m,
  history7d,
  history30d,
  pageHitsLog,
  pageHitsMap,
  recordDbHit,
  recordErrorPageHit,
  recordRouteHit,
} from './core'

export default function analyticsPlugin() {
  return definePlugin({
    name: 'analytics',
    async setup() {
      const { setupAnalytics } = await import('./setup')
      setupAnalytics()
    },
    onRoute(req) {
      const url = new URL(req.url)
      recordRouteHit(req.method, url.pathname, url.search)
    },
    onStart: async server => {
      const { startAnalyticsLoop } = await import('./setup')
      startAnalyticsLoop(server)
    },

    onError: recordErrorPageHit,
  })
}
