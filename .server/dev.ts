import './core/init'
import { errorMsg, log, serveLog } from './logger'

log({
  by: 'process',
  msg: `Starting server (PID: ${process.pid})...`,
})
serveLog.STARTING({ mode: 'development' })

try {
  const { initConfig } = await import('./core/config')
  const { initImportMap, initHostImportMaps } = await import('./utils/http')
  const { PluginHooks } = await import('./core/plugins')
  const { syncTSConfigPaths } = await import('./compiler/tsconfig-sync')

  await initConfig()
  await PluginHooks.setup()
  await initImportMap()
  initHostImportMaps()
  await syncTSConfigPaths()
} catch (error: any) {
  console.error('Config init error stack:', error)
  serveLog.UNHANDLED_ERR({ error: `Config init failed: ${errorMsg(error)}` })
  process.exit(1)
}

try {
  const { SyncService } = await import('@database/sync')
  await SyncService.run()
} catch (error: any) {
  serveLog.UNHANDLED_ERR({ error: `Startup failed: ${errorMsg(error)}` })
  process.exit(1)
}

await import('./worker')
