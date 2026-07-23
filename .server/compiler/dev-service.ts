import { watch } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { initRoutes } from '@server/cache'
import { Bakery } from '@server/core/bakery'
import { Try } from '@server/utils'
import { Glob } from '@server/utils/fs'
import { compLog, serveLog } from '../logger'
import { PromptTracker } from './prompt-tracker'

export function notifySockets(server: any, filename: string) {
  const serveRoot = Bakery.serveRoot || '.'
  const relativePath = relative(resolve(serveRoot), resolve(filename)).replace(
    /\\/g,
    '/',
  )
  server?.publish('livereload', relativePath)
}


function setupPingInterval(
  url: string,
  signal: AbortSignal,
  onServerUp: () => void,
): any {
  const interval = setInterval(async () => {
    if (signal.aborted) return clearInterval(interval)

    try {
      await fetch(url, {
        method: 'HEAD',
        headers: { 'User-Agent': 'dev-watcher-ping' },
      })
      onServerUp()
      clearInterval(interval)
    } catch {
      // Continue waiting
    }
  }, 200)
  return interval
}

function setupPromptCheckInterval(
  workerPid: number,
  signal: AbortSignal,
  isRawModeActive: () => boolean,
  isServerUp: () => boolean,
  disableRaw: () => void,
  enableRaw: () => void,
): any {
  const interval = setInterval(async () => {
    if (signal.aborted) return clearInterval(interval)

    const promptActive = await PromptTracker.isActive(workerPid)

    if (promptActive && isRawModeActive()) return disableRaw()
    if (!promptActive && isServerUp() && !isRawModeActive()) return enableRaw()
  }, 100)

  return interval
}

function createTTYManager(getWorker: () => Bun.Subprocess | null) {
  let rawModeActive = false

  const stdinHandler = (key: string) => {
    switch (key.toLowerCase()) {
      case '\u0003':
        return getWorker()?.kill('SIGINT')
      case 's':
        return process.emit('SIGINT')
    }
  }

  return {
    get isRawModeActive() {
      return rawModeActive
    },
    disableRawMode: () => {
      rawModeActive = false
      if (!process.stdin.isTTY) return

      Try(() => process.stdin.setRawMode(false))
      process.stdin.off('data', stdinHandler)
      Try(() => process.stdin.pause())
    },
    enableRawMode: () => {
      rawModeActive = true
      if (!process.stdin.isTTY) return

      Try(() => {
        process.stdin.setRawMode(true)
        process.stdin.resume()
        process.stdin.setEncoding('utf8')
        process.stdin.off('data', stdinHandler)
        process.stdin.on('data', stdinHandler)
      })
    },
  }
}

export async function handleDevMaster(): Promise<never> {
  const { initConfig } = await import('@server/core/config')
  const config = await initConfig()

  const port = process.env.PORT
    ? parseInt(process.env.PORT, 10)
    : config.port || 3000
  const host =
    config.host === '0.0.0.0' ? '127.0.0.1' : config.host || '127.0.0.1'
  const url = `http://${host}:${port}/`

  let workerProc: Bun.Subprocess<'inherit', 'inherit', 'inherit'> | null = null
  let abortController: AbortController | null = null

  const tty = createTTYManager(() => workerProc)

  const cleanupAndExit = () => {
    workerProc?.kill('SIGINT')
    tty.disableRawMode()
    if (workerProc?.pid) {
      PromptTracker.deactivate(workerProc.pid)
    }
    process.exit(0)
  }

  process.on('SIGINT', cleanupAndExit)
  process.on('SIGTERM', cleanupAndExit)

  async function startWatcher(): Promise<never> {
    tty.disableRawMode()
    abortController?.abort()
    abortController = new AbortController()
    const signal = abortController.signal

    if (workerProc?.pid) {
      PromptTracker.deactivate(workerProc.pid)
    }

    const isDetached = process.env.DETACHED === '1'
    const inspectArgs = [...process.execArgv, ...process.argv].filter(arg =>
      arg.startsWith('--inspect'),
    )

    workerProc = Bun.spawn(
      [
        process.execPath,
        '--smol',
        ...inspectArgs,
        '.server/index.ts',
        '--dev',
        '--dev-worker',
      ],
      {
        stdio: [isDetached ? 'ignore' : 'inherit', 'inherit', 'inherit'],
        windowsHide: isDetached,
        env: {
          ...process.env,
          DEV_WATCHER_ACTIVE: '1',
        },
      },
    )

    let serverUp = false
    const pingInterval = setupPingInterval(url, signal, () => {
      serverUp = true
    })
    const checkInterval = setupPromptCheckInterval(
      workerProc.pid,
      signal,
      () => tty.isRawModeActive,
      () => serverUp,
      tty.disableRawMode,
      tty.enableRawMode,
    )

    const code = (await workerProc.exited) ?? 0

    clearInterval(pingInterval)
    clearInterval(checkInterval)
    tty.disableRawMode()
    if (workerProc?.pid) {
      PromptTracker.deactivate(workerProc.pid)
    }

    if (code === 42) {
      serveLog.RESTART_REQ()
      console.clear()
      return startWatcher()
    }

    if (code === 130) {
      serveLog.SHUTTING_DOWN()
      return process.exit(0)
    }

    return process.exit(code)
  }

  await startWatcher()
  process.exit(0)
}

const pkgFilesGlob = Glob.strings('package.json', 'bun.lock', 'bun.lockb')
const fileTypeGlob = Glob.fromExt([
  'css',
  'html',
  'ts',
  'js',
  'tsx',
  'jsx',
  'vue',
])
const tsScriptGlob = Glob.fromExt(['ts', 'js', 'html', 'vue'])
const watchIgnores = Glob.strings(
  'node_modules/**/*',
  '**/.git/**/*',
  '**/.vscode/**/*',
  '**/.backups/**/*',
  '**/.cache/**/*',
  'schema.ts',
)

const prioFilesGlob = Glob.strings(
  'server.config.ts',
  'api/**/*',
  '**/.server/**/*',
  '**/*.tsx',
)

async function processFileEvent(
  filePath: string,
  server: any,
  isDevWorker: boolean,
) {
  if (isDevWorker) {
    if (prioFilesGlob.match(filePath)) {
      serveLog.BACKEND_CHANGE({ file: filePath })
      return process.exit(42)
    }

    if (tsScriptGlob.match(filePath)) {
      initRoutes()
      return notifySockets(server, filePath)
    }

    if (fileTypeGlob.match(filePath)) {
      return notifySockets(server, filePath)
    }
  }

  if (await Bun.file(filePath).exists()) {
    return compLog.FILE_STATUS({ status: 'changed', file: filePath })
  }

  compLog.FILE_DEL({ file: filePath })
  if (isDevWorker) notifySockets(server, filePath)
}

export async function startCompileService(server: any): Promise<void> {
  if (!import.meta.env.DEV) return
  const watcher = watch('./', { recursive: true })
  const isDevWorker = Boolean(import.meta.env.DEV_WORKER && import.meta.env.DEV)

  for await (const { filename } of watcher) {
    if (!filename) continue
    const filePath = filename.replace(/\\/g, '/')

    if (watchIgnores.match(filePath) || !fileTypeGlob.match(filePath)) {
      continue
    }

    if (pkgFilesGlob.match(filePath)) {
      compLog.FILE_STATUS({ status: 'changed', file: filePath })
      continue
    }

    await processFileEvent(filePath, server, isDevWorker)
  }
}
