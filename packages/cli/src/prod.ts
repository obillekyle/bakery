import '@bakery/core/core/init'
import { errorMsg, log, serveLog } from '@bakery/core/logger'

log({
  by: 'process',
  msg: `Starting server (PID: ${process.pid})...`,
})
serveLog.STARTING({ mode: 'production' })

try {
  const { initConfig } = await import('@bakery/core/core/config')
  const { setupPlugins } = await import('@bakery/core/startup')
  const { initImportMap, initHostImportMaps } = await import(
    '@bakery/core/utils/http'
  )

  await initConfig()
  // Before initImportMap() so plugin-contributed entries land in it; memoised,
  // so the later setupServer() call inside worker.ts does not repeat it.
  await setupPlugins()
  await initImportMap()
  initHostImportMaps()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

try {
  const { initDB } = await import('@bakery/orm/connection')
  await initDB()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({
    error: `Database initialization failed: ${errorMsg(error)}`,
  })
  process.exit(1)
}

try {
  await import('./worker')
} catch (err: any) {
  serveLog.UNHANDLED_ERR({
    error: `Worker initialization failed: ${errorMsg(err)}`,
  })
  process.exit(1)
}
