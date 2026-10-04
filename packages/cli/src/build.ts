import { errorMsg, serveLog } from '@bakery-framework/core/logger'

/**
 * `bakery --build`: the work a production start can have done ahead of it,
 * which is whatever the app's plugins do in their `build` hook. plugin-vue
 * bundles every page there.
 *
 * Production by construction: the flags make anything without `--dev`
 * production, so the output is minified and keyed to the production cache,
 * which `initConfig` empties first when the app or the framework has a new
 * version. Nothing is served and no database is opened.
 *
 * Returns the exit code: 1 when any plugin failed, so a deploy stops there.
 */
export async function build(): Promise<number> {
  try {
    const { initConfig } = await import('@bakery-framework/core/core/config')
    const { buildPlugins } = await import('@bakery-framework/core/startup')

    await initConfig()
    const { built, failed } = await buildPlugins()

    if (failed.length) {
      serveLog.BUILD_FAILED({ plugins: failed.join(', ') })
      return 1
    }
    if (!built.length) serveLog.BUILD_NOTHING()
    return 0
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({ error: `bakery --build: ${errorMsg(error)}` })
    return 1
  }
}
