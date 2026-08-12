import { definePlugin } from '@bakery-framework/core/plugins'
import type { AuthorizeFn } from './authorize'

export type { AuthorizeFn } from './authorize'

export interface DbExplorerPluginOptions {
  /**
   * Register the explorer. Defaults to true; set false to keep it out of a
   * build entirely.
   */
  enabled?: boolean

  /**
   * Decide whether a request may browse the database. Return true to allow.
   *
   * The explorer authenticates nobody itself — the application does, because
   * it already knows who its users are:
   *
   * ```ts
   * dbExplorerPlugin({
   *   authorize: req => req.session.get('role') === 'admin',
   * })
   * ```
   *
   * Omitted, access is loopback-only in development and denied in
   * production, so an unconfigured explorer is never exposed.
   */
  authorize?: AuthorizeFn

  /**
   * A shared access key, typically from the environment:
   *
   * ```ts
   * dbExplorerPlugin({ credential: import.meta.env.DB_EXPLORER_KEY })
   * ```
   *
   * Presented as `Authorization: Bearer`, an `x-db-key` header, or a
   * one-time `?key=` query for a browser (stored client-side, stripped from
   * the URL). Checked in constant time. Unset or empty means this path is
   * off — it never means open. Composes with `authorize`: either admits.
   */
  credential?: string
}

/**
 * A read-only database browser at `/_db`: table list, rows, paging, sorting.
 *
 * Read-only is the contract, not a mode. There is no raw-SQL endpoint, no
 * row mutation, and no DDL — where the dashboard gates its write paths
 * behind `DASHBOARD_ALLOW_WRITES`, the explorer has no write paths to gate.
 */
export default function dbExplorerPlugin(
  options: DbExplorerPluginOptions = {},
) {
  const enabled = options.enabled ?? true

  return definePlugin({
    name: 'db-explorer',
    async setup() {
      if (!enabled) return
      const { setupExplorer } = await import('./setup')
      setupExplorer({
        authorize: options.authorize,
        credential: options.credential,
      })
    },
  })
}
