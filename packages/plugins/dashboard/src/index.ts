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
   */
  authorize?: AuthorizeFn
}

export default function dashboardPlugin(options: DashboardPluginOptions = {}) {
  const enabled = options.enabled ?? true

  return definePlugin({
    name: 'dashboard',
    async setup() {
      if (!enabled) return
      const { setupDashboard } = await import('./setup')
      await setupDashboard({ authorize: options.authorize })
    },
  })
}
