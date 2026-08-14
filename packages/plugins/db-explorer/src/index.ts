import { definePlugin } from '@bakery-framework/core/plugins'
import type { AccessConfig } from './access'

/**
 * Part of this plugin's public surface.
 *
 * These are the explorer's own rather than core's `AuthorizeFn`, because the
 * explorer asks a different question. The dashboard and analytics need to know
 * *whether* a request is admitted; the explorer edits rows, so it needs to know
 * *what* the request may do. A boolean cannot carry that.
 */
export type { Access, AccessFn, ExplorerUser, ExplorerUsers } from './access'

export interface DbExplorerPluginOptions extends AccessConfig {
  /**
   * Register the explorer. Defaults to true; set false to keep it out of a
   * build entirely.
   */
  enabled?: boolean
}

/**
 * A database browser and editor at `/_db`: table list, rows, paging, sorting,
 * inline editing, foreign-key navigation and CSV import.
 *
 * **No raw SQL and no DDL.** That is structural, not a mode: there is no
 * endpoint that runs a statement you supply, and none that creates, drops or
 * alters a table. What CRUD changed is row data. Where the dashboard gated its
 * write paths behind an environment flag, the explorer still has no path for
 * the things it refuses.
 *
 * Nobody is admitted until an application says who may come in, and access is
 * a level rather than a yes:
 *
 * ```ts
 * dbExplorerPlugin({
 *   users: {
 *     ops:    { credential: process.env.OPS_KEY!,    access: 'write' },
 *     oncall: { credential: process.env.ONCALL_KEY!, access: 'read'  },
 *   },
 *   authorize: req => (req.session.get('role') === 'admin' ? 'write' : false),
 * })
 * ```
 *
 * Either door admits and the higher level wins — a session admin presenting a
 * read-only key is still an admin. With neither configured the explorer admits
 * nobody, which is the same default it had when it was read-only, and the
 * reason there is no `writes: true` flag to leave set by accident.
 *
 * A `read` caller gets the grid with no edit affordances and a 403 on every
 * write endpoint. A table with no primary key or unique index is read-only for
 * everyone: there is no way to name one of its rows, so there is no way to
 * change one safely.
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
      setupExplorer({ users: options.users, authorize: options.authorize })
    },
  })
}
