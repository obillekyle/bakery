import { Logger, messageLogger } from '@bakery-framework/core/logger'

/**
 * The plugin's own declared message table (convention 4).
 *
 * Declared here rather than added to core's `pluginLog`, on the same reasoning
 * the ORM uses for `sync/engine.ts` and `backup.ts`: a message belongs to the
 * package that emits it. `ANALYTICS_STORE_ERR` still lives in core's table —
 * moving it is a change to `@bakery-framework/core`, not to this plugin.
 */
const analyticsMsgs = {
  /**
   * The flush that used to fail silently. Not a `trace`: on the shutdown path
   * this is the last flush there will ever be, so it is a lost write, not a
   * skipped retry.
   */
  SAVE_ERR: 'E Analytics flush failed: %r{error}%*',
  LOOP_ERR: 'W Analytics loop tick failed: %r{error}%*',
} as const

export const analyticsLog = messageLogger(
  new Logger('analytics'),
  analyticsMsgs,
)
