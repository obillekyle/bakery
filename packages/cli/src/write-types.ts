import { errorMsg, serveLog } from '@bakery-framework/core/logger'

/**
 * `bakery --types`: the TypeScript projects a dev boot writes, without the boot.
 *
 * The app's `tsconfig.json` reaches its scope projects through
 * `tsconfig.bakery.json`, and both that file and `.cache/tsconfig/` are
 * generated. A fresh clone has neither, so `tsc` stops at TS6053 and an editor
 * leaves every file in an inferred project until something writes them. This
 * is that something, for a clone, a CI job or a `typecheck` script.
 *
 * **Not the whole dev init.** `dev.ts` runs `setupPlugins()` first because a
 * plugin's `setup()` may add import-map entries, but a setup also does work
 * (analytics registers a shutdown hook and starts loading its data), and
 * nothing a setup adds today changes what this writes: the one plugin that
 * touches the import map, plugin-vue, maps a served URL, which the paths sync
 * skips. The projects come from each plugin's `tsconfig.project`, which is on
 * the config and needs no setup.
 *
 * **It checks its own result.** `syncTSConfigProjects` logs a failure rather
 * than throwing, so a dev boot never dies over a tsconfig, and that would let
 * this exit 0 having written nothing: a step a CI job trusts, passing when it
 * did not work. So the chain file is read back, and every project it lists
 * has to exist.
 *
 * Returns the exit code.
 */
export async function writeTypes(): Promise<number> {
  try {
    const { initConfig } = await import('@bakery-framework/core/core/config')
    const { syncTSConfigPaths, syncTSConfigProjects } = await import(
      '@bakery-framework/core/compiler/tsconfig-sync'
    )

    await initConfig()
    await syncTSConfigPaths()
    await syncTSConfigProjects()

    const chain = Bun.file(`${process.cwd()}/tsconfig.bakery.json`)
    if (!(await chain.exists())) {
      throw new Error('tsconfig.bakery.json was not written')
    }
    const { references } = (await chain.json()) as {
      references?: { path: string }[]
    }
    for (const { path } of references ?? []) {
      if (!(await Bun.file(`${process.cwd()}/${path}`).exists())) {
        throw new Error(`${path} is listed in tsconfig.bakery.json but missing`)
      }
    }
    return 0
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({ error: `bakery --types: ${errorMsg(error)}` })
    return 1
  }
}
