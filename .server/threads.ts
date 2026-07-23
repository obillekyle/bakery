import { log, serveLog } from './logger'
import { Try } from './utils/common'

export async function handleThreadsMaster(threadCount: number) {
  if (process.platform === 'win32' && threadCount > 1) {
    log({
      level: 'warn',
      msg: `[Cluster] Windows does not support SO_REUSEPORT for multi-worker port sharing. Automatically adjusting to 1 worker thread.`,
    })
    threadCount = 1
  }

  let Bakery: any
  try {
    const configMod = await import('./core/config')
    const bakeryMod = await import('./core/bakery')
    await configMod.initConfig()
    Bakery = bakeryMod.Bakery
  } catch (error: any) {
    serveLog.UNHANDLED_ERR({
      error: `Fatal error during master startup: ${error?.stack || error}`,
    })
    process.exit(1)
  }

  if (threadCount === 1 || process.platform === 'win32') {
    Try(() => { (process.env as any).THREAD_WORKER = '1' })
    Try(() => { (process.env as any).THREAD_ID = '0' })
    await import('./prod')
    await new Promise(() => {})
    return
  }

  serveLog.STARTING_THREADS({ count: threadCount })

  const workers = new Map<number, Worker>()
  const workerState = new Map<number, { isTerminated: boolean }>()

  const spawnWorker = (id: number) => {
    workerState.set(id, { isTerminated: false })

    const worker = new Worker(new URL('./worker.ts', import.meta.url).href, {
      env: {
        ...process.env,
        THREAD_WORKER: '1',
        THREAD_ID: String(id),
      },
    })

    workers.set(id, worker)

    worker.postMessage({
      type: 'INIT_SHARED_POOL',
      buffer: Bakery.sharedPool.buffer,
    })

    worker.addEventListener('error', err => {
      serveLog.UNHANDLED_ERR({
        error: `Worker ${id} error: ${err.message || String(err)}`,
      })
    })

    worker.addEventListener('close', () => {
      const state = workerState.get(id)
      if (state?.isTerminated) return

      log({
        level: 'warn',
        msg: `[Cluster] Worker ${id} exited unexpectedly. Restarting...`,
      })
      workers.delete(id)
      setTimeout(() => spawnWorker(id), 100)
    })
  }

  for (let i = 0; i < threadCount; i++) {
    spawnWorker(i)
  }

  async function handleShutdown(signal: string) {
    log({ level: 'info', msg: `Received ${signal}, shutting down cluster...` })
    serveLog.SHUTTING_DOWN()

    for (const [id, worker] of workers.entries()) {
      const state = workerState.get(id)
      if (state) state.isTerminated = true
      worker.terminate()
    }
    workers.clear()

    const { PluginHooks } = await import('./core/plugins')
    await PluginHooks.onShutdown()

    process.exit(0)
  }

  process.on('SIGINT', () => handleShutdown('SIGINT'))
  process.on('SIGTERM', () => handleShutdown('SIGTERM'))

  await new Promise(() => {})
}
