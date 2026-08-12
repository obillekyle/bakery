import { definePlugin } from '@bakery-framework/core/plugins'
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

export interface AnalyticsPluginOptions {
  /**
   * A shared access key for the analytics endpoints and websocket, typically
   * from the environment:
   *
   * ```ts
   * analyticsPlugin({ credential: import.meta.env.ANALYTICS_KEY })
   * ```
   *
   * Presented as `Authorization: Bearer`, an `x-analytics-key` header, or an
   * `?analytics-key=` query. Checked in constant time; unset or empty means
   * this path is off, never open. This is the reachable door: nothing sets
   * the legacy DASHPASS session flag since the dashboard dropped its login,
   * so without a credential the endpoints stay closed to everyone.
   */
  credential?: string
}

export default function analyticsPlugin(options: AnalyticsPluginOptions = {}) {
  return definePlugin({
    name: 'analytics',
    async setup() {
      const { setupAnalytics } = await import('./setup')
      setupAnalytics({ credential: options.credential })
    },
    onRoute(req) {
      const url: URL = (req as any).__parsedUrl || new URL(req.url)
      recordRouteHit(req.method, url.pathname, url.search)
    },
    onStart: async server => {
      const { startAnalyticsLoop } = await import('./setup')
      startAnalyticsLoop(server)
    },

    onError: recordErrorPageHit,
  })
}
