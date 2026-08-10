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

/**
 * Hash everything the boot-time schema sync reads: the schema source files
 * (resolved with the same probe order as orm/sync/load.ts — configured path,
 * then the `orm/` folder layout, then a root `schema.ts`) plus the DB target,
 * since switching `DB_URL` changes what "synced" means.
 *
 * Returns `null` for any indeterminate state — a configured path that does not
 * exist, an unreadable file — so `classifySchemaSync` fails closed into
 * re-syncing. Total absence of a schema is *not* indeterminate (it is a
 * supported state for the defaults) and hashes to a stable value.
 */
async function computeSchemaHash(
  configured: string | undefined,
): Promise<string | null> {
  const { fs, Try } = await import('@bakery-framework/core/utils')

  const files: string[] = []
  const scanDir = async (dir: string) => {
    for await (const file of new Bun.Glob('*.ts').scan({
      cwd: dir,
      absolute: true,
    })) {
      files.push(file)
    }
  }

  const [error] = await Try.catch(
    (async () => {
      if (configured) {
        const path = fs.resolve(fs.cwd, configured)
        if (await fs.isDir(path)) {
          await scanDir(path)
        } else if (await Bun.file(path).exists()) {
          files.push(path)
        } else {
          // Configured-but-missing is SyncService's SCHEMA_NOT_FOUND case:
          // let the sync run and produce its proper error.
          throw new Error(`configured schema path not found: ${path}`)
        }
      } else if (await Bun.file(`${fs.cwd}/orm/index.ts`).exists()) {
        await scanDir(`${fs.cwd}/orm`)
      } else if (await Bun.file(`${fs.cwd}/schema.ts`).exists()) {
        files.push(`${fs.cwd}/schema.ts`)
      }
    })(),
  )
  if (error) return null

  files.sort()
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(process.env.DB_URL || process.env.DATABASE_URL || '')
  for (const file of files) {
    hasher.update(`\0${file}\0`)
    const [readError, content] = await Try.catch(Bun.file(file).text())
    if (readError) return null
    hasher.update(content)
  }
  return hasher.digest('hex')
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
