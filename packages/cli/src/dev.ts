import '@bakery-framework/core/core/init'
import { errorMsg, log, serveLog } from '@bakery-framework/core/logger'
import { hasORM } from './orm'

log({
  by: 'process',
  msg: `Starting server (PID: ${process.pid})...`,
})
serveLog.STARTING({ mode: 'development' })

let config: unknown

try {
  const { initConfig } = await import('@bakery-framework/core/core/config')
  const { initImportMap, initHostImportMaps } = await import(
    '@bakery-framework/core/utils/http'
  )
  const { setupPlugins } = await import('@bakery-framework/core/startup')
  const { syncTSConfigPaths, syncTSConfigProjects } = await import(
    '@bakery-framework/core/compiler/tsconfig-sync'
  )

  config = await initConfig()
  // Still before initImportMap(): a plugin's setup() may contribute entries.
  // setupPlugins() memoises, so setupServer()'s later call is a no-op here.
  await setupPlugins()
  await initImportMap()
  initHostImportMaps()
  await syncTSConfigPaths()
  // After setupPlugins(), so the plugin list is populated and each plugin
  // contributing a project has been loaded.
  await syncTSConfigProjects()
} catch (error: any) {
  // errorMsg() already yields the stack, so the structured line below carries
  // everything the raw console.error used to duplicate.
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

// The entire block is schema sync, so with no ORM there is nothing here to do.
// Silently: a dev boot of an app that never had a database should not report
// the absence of one on every reload.
if (hasORM()) {
  try {
    const { Bakery } = await import('@bakery-framework/core')
    const { classifySchemaSync } = await import(
      '@bakery-framework/core/compiler'
    )
    const { schemaFromConfig } = await import('@bakery-framework/orm/sync/load')
    const { Try } = await import('@bakery-framework/core/utils')
    // Dynamic, like every other import in this block: `schema-hash.ts` is only
    // needed when the ORM is installed, and a static import would pull it (and
    // its own dynamic core barrel) onto the no-ORM boot path.
    const { computeSchemaHash } = await import('./schema-hash')

    const hashFile = `${Bakery.cacheDir}/schema-sync.hash`
    const currentHash = await computeSchemaHash(schemaFromConfig(config))
    const [, stored] = await Try.catch(Bun.file(hashFile).text())

    const decision = classifySchemaSync({
      force: process.argv.includes('--sync') || process.argv.includes('-s'),
      currentHash,
      storedHash: stored?.trim() || null,
      // Only meaningful for the default SQLite target; with a DB_URL there is
      // no local file to stat, and the hash (which covers DB_URL) plus `--sync`
      // are the levers for an externally reset database.
      dbMissing:
        !process.env.DB_URL &&
        !process.env.DATABASE_URL &&
        !(await Bun.file(`${Bakery.dataDir}/server.db`).exists()),
    })

    if (decision === 'skip') {
      serveLog.SCHEMA_SYNC_SKIP()
      // Only on the skip path. When a sync runs it reports drift itself, from
      // the plan it just built; here nothing else would ever look. Measured at
      // 2.7ms median against apps/example (4 tables) — it is one introspection
      // pass, so it grows with table count, which is why it is not on the path
      // that is about to introspect anyway.
      const { initDB, connection } = await import(
        '@bakery-framework/orm/connection'
      )
      const { detectDrift } = await import('@bakery-framework/orm/sync/ledger')
      await initDB()
      const drift = await detectDrift(connection)
      if (drift) serveLog.SCHEMA_DRIFT({ reason: drift.reason })
    } else {
      const { SyncService } = await import('@bakery-framework/orm/sync')
      await SyncService.run()
      // Recorded only after run() resolves: a failed or aborted sync must leave
      // the previous hash (or none) behind so the next boot re-syncs.
      if (currentHash) {
        const [writeError] = await Try.catch(Bun.write(hashFile, currentHash))
        // A failed record is tolerated silently: its only consequence is that
        // the next boot syncs again, which is the safe direction.
        void writeError
      }
    }
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({ error: `Startup failed: ${errorMsg(error)}` })
    process.exit(1)
  }
}

await import('./worker')
