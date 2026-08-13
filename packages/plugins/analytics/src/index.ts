import { definePlugin } from '@bakery-framework/core/plugins'
import { parsedUrl } from '@bakery-framework/core/utils/http'
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

export type { AuthorizeFn } from './endpoints/stats'

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
   * this door is closed. The same key gates the dashboard, which delegates
   * its auth here.
   */
  credential?: string

  /**
   * A request predicate for role-based access, as an alternative or addition
   * to the shared key: `authorize: req => req.session.get('role') === 'admin'`.
   * Either door admits; both fail closed. With neither, analytics is off.
   */
  authorize?: import('./endpoints/stats').AuthorizeFn
}

export default function analyticsPlugin(options: AnalyticsPluginOptions = {}) {
  return definePlugin({
    name: 'analytics',
    async setup() {
      const { setupAnalytics } = await import('./setup')
      setupAnalytics({
        credential: options.credential,
        authorize: options.authorize,
      })
    },
    onRoute(req) {
      const url = parsedUrl(req)
      recordRouteHit(req.method, url.pathname, url.search)
    },
    onStart: async server => {
      const { startAnalyticsLoop } = await import('./setup')
      startAnalyticsLoop(server)
    },

    onError: recordErrorPageHit,
  })
}
