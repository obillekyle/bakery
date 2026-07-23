import './core/init'
import { errorMsg, log, serveLog } from './logger'

log({
  by: 'process',
  msg: `Starting server (PID: ${process.pid})...`,
})
serveLog.STARTING({ mode: 'production' })

try {
  const { initConfig } = await import('./core/config')
  const { PluginHooks } = await import('./core/plugins')
  const { initImportMap, initHostImportMaps } = await import('./utils/http')

  await initConfig()
  await PluginHooks.setup()
  await initImportMap()
  initHostImportMaps()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

try {
  const { initDB } = await import('./database/connection')
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
  serveLog.UNHANDLED_ERR({ error: `Worker initialization failed: ${errorMsg(err)}` })
  process.exit(1)
}
