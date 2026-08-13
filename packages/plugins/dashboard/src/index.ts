import { definePlugin } from '@bakery-framework/core/plugins'
import type { AuthorizeFn } from '@bakery-framework/core/utils/http'

/**
 * Re-exported so the plugin's public surface is unchanged by the guard moving
 * into core. It is the same type either way — an app that imported it from here
 * keeps working, and one that reaches for `@bakery-framework/core/utils/http`
 * directly gets the identical declaration rather than a structural twin.
 */
export type { AuthorizeFn } from '@bakery-framework/core/utils/http'

export interface DashboardPluginOptions {
  /**
   * Register the dashboard. Defaults to true. Set to false to keep it out of a
   * build entirely — the documented way to disable it in production.
   */
  enabled?: boolean

  /**
   * Decide whether a request may use the console. Return true to allow.
   *
   * The dashboard does not authenticate anyone itself; the application does,
   * because it is the thing that already knows who its users are:
   *
   * ```ts
   * dashboardPlugin({
   *   authorize: req => req.session.get('role') === 'admin',
   * })
   * ```
   *
   * Omitted, access is limited to loopback in development and denied in
   * production, so an unconfigured console is never exposed.
   *
   * Handed straight to `@bakery-framework/plugin-analytics`, which owns the
   * door for both surfaces — so this predicate also admits to
   * `/api/_analytics/stats` and the `/_analytics_ws` socket the console reads.
   */
  authorize?: AuthorizeFn

  /**
   * A shared access key, typically from the environment:
   *
   * ```ts
   * dashboardPlugin({ credential: import.meta.env.ANALYTICS_KEY })
   * ```
   *
   * Presented as `Authorization: Bearer`, an `x-analytics-key` header, or an
   * `?analytics-key=` query. Checked in constant time. Unset or empty means
   * this path is off — it never means open. Composes with `authorize`: either
   * admits.
   *
   * It is the *analytics* key, not a second one: the console delegates its
   * authorization to `@bakery-framework/plugin-analytics`, so configuring it
   * here and configuring it on `analyticsPlugin` are the same act. Set it on
   * either plugin — a bare call never clears what the other one set.
   */
  credential?: string
}

/**
 * The operator console at `/_dashboard`.
 *
 * `@bakery-framework/plugin-analytics` is a hard dependency, not an optional
 * companion: the console renders analytics, its client calls
 * `/api/_analytics/reset` and opens `/_analytics_ws`, and registering the
 * dashboard brings analytics' handlers up so those endpoints exist. It follows
 * that they share one door rather than two — see `authorize` and `credential`
 * above.
 */
export default function dashboardPlugin(options: DashboardPluginOptions = {}) {
  const enabled = options.enabled ?? true

  return definePlugin({
    name: 'dashboard',
    async setup() {
      if (!enabled) return
      const { setupDashboard } = await import('./setup')
      await setupDashboard({
        authorize: options.authorize,
        credential: options.credential,
      })
    },
  })
}
