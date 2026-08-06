import { watch } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { initRoutes } from '../cache'
import { Bakery } from '../core/bakery'
import { Try } from '../utils'
import { Glob, fs } from '../utils/fs'
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

/**
 * Push an error to every connected browser as a JSON frame:
 * `{type: 'error', title, body}`. client/livereload.ts renders it as an
 * overlay and removes it on the next successful reload frame.
 *
 * Legacy reload frames stay plain filename strings — the client distinguishes
 * the two by a leading `{`, so this must always be JSON and filenames must
 * never be. Paths that cannot reach a live socket at all (worker dead, boot
 * failure before `Bun.serve`) are covered client-side by the disconnect
 * overlay instead.
 */
export function notifyError(server: any, title: string, body: string) {
  server?.publish('livereload', JSON.stringify({ type: 'error', title, body }))
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
      // A refused connection is the expected state until the server binds.
      // The interval simply pings again; there is nothing to report.
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
  const { initConfig } = await import('../core/config')
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
        // Respawn whatever entry started this process. The entry now lives in
        // @bakery/cli, and core must not reach into a package that depends on
        // it — argv[1] is both correct and dependency-free.
        process.argv[1],
        '--dev',
        '--dev-worker',
        // `--sync` means "force the schema sync"; without forwarding it the
        // dev worker's hash-skip (cli/dev.ts) would judge the schema unchanged
        // and override the developer's explicit ask on every respawn.
        ...(process.argv.includes('--sync') || process.argv.includes('-s')
          ? ['--sync']
          : []),
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
      // Clear only when the exiting worker had actually come up: then the
      // scrollback is routine request logs and clearing keeps the console
      // readable. A worker that exited before binding — the sync engine also
      // exits 42 mid-boot (orm/sync/engine.ts) — printed the only record of
      // why, and wiping it left the developer staring at a blank screen where
      // the error had just been. Keeping scrollback is chosen over
      // capture-and-reprint because worker stdio is inherited, not piped.
      if (serverUp) console.clear()
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
// `.tsx`/`.jsx` are here — the cheap path — and not in `prioFilesGlob`:
// TSXHandler re-imports the page module with `?v=<mtime>` (handlers/assets/
// tsx.ts, same mechanism as ApiHandler), so an edited page never serves stale
// and the route-cache flush + browser reload below is all a page edit needs.
const tsScriptGlob = Glob.fromExt(['ts', 'js', 'html', 'vue', 'tsx', 'jsx'])
const watchIgnores = Glob.strings(
  'node_modules/**/*',
  '**/.git/**/*',
  '**/.vscode/**/*',
  '**/.backups/**/*',
  '**/.cache/**/*',
  '**/.bakery/**/*',
  // `.data` holds the database plus `backups/schema.<timestamp>.ts` files the
  // DB backup writes at runtime — without this, taking a backup while the dev
  // server ran flushed the route cache and reloaded the browser.
  '**/.data/**/*',
  // `**/` so nested layouts (e.g. `orm/schema.ts`) are covered too. schema.ts
  // anywhere in the tree is the ORM schema convention; route files are never
  // named schema.ts, so the breadth is safe.
  '**/schema.ts',
)

// `'api/**/*'` used to be a third entry here, left over from when API routes
// lived at the repo root. They live under `<root>/api` now — `src/api` by
// default — so the pattern matched nothing and API routes never triggered the
// restart below. The route *file* still hot-reloaded through the `?v=<mtime>`
// cache-buster, which is why this looked fine: only its imports went stale.
// The replacement is `isBackendPriorityFile`, which asks the config where the
// api directory actually is instead of hard-coding it.
//
// `'**/*.tsx'` was the second entry here, and it made every page edit — the
// most common edit there is — cost a full process restart (config, plugins,
// import map, tsconfig sync, schema-sync check). The only reason it needed a
// restart was Bun's module registry caching the imported page module, and
// TSXHandler now busts that per request in dev exactly as ApiHandler always
// has. Pages take the cheap path via `tsScriptGlob` above. The one thing the
// restart still bought — flushing *components* a page imports — is a
// documented limitation (docs/getting-started/first-app.md): touch
// server.config.ts or restart when editing a shared Layout.tsx.
const prioFilesGlob = Glob.strings('server.config.ts')

/**
 * Whether a change to `filePath` requires a full backend restart rather than a
 * livereload notification.
 *
 * `filePath` is watcher-relative — i.e. relative to the app's cwd, with forward
 * slashes — so the configured api root is converted to the same shape.
 *
 * Host-specific roots are not consulted: a `hosts` entry can override `root`,
 * but the watcher runs outside any request and so has no host context. The
 * process-level root is the one that covers the common case.
 */
export function isBackendPriorityFile(filePath: string): boolean {
  if (prioFilesGlob.match(filePath)) return true

  const apiRoot = relative(fs.cwd, Bakery.apiRoot).replace(/\\/g, '/')
  // Empty means the api dir *is* the cwd; '..' means it sits outside the tree
  // this watcher covers. Neither can match a watcher-relative path.
  if (!apiRoot || apiRoot.startsWith('..')) return false

  return filePath === apiRoot || filePath.startsWith(`${apiRoot}/`)
}

/**
 * Whether a dev-worker boot needs to run the ORM schema sync.
 *
 * Every boot used to run the full sync unconditionally, and it dominated
 * restart time. cli/dev.ts now hashes the schema sources, records the hash
 * under `.bakery/cache/` after a *successful* sync only, and consults this
 * before the next one. Pure so the fail-closed branches are testable: any
 * indeterminate state (`currentHash: null` — sources unreadable; `storedHash:
 * null` — no successful sync on record) must sync, never skip.
 */
export function classifySchemaSync(opts: {
  /** `--sync` / `-s` was passed: the developer asked, so sync regardless. */
  force: boolean
  /** Hash of the current schema sources, or null if it could not be computed. */
  currentHash: string | null
  /** Hash recorded after the last successful sync, or null if none. */
  storedHash: string | null
  /** The local database file is gone (e.g. `.data/` deleted to reset). */
  dbMissing: boolean
}): 'sync' | 'skip' {
  if (opts.force) return 'sync'
  if (opts.dbMissing) return 'sync'
  if (opts.currentHash === null || opts.storedHash === null) return 'sync'
  return opts.currentHash === opts.storedHash ? 'skip' : 'sync'
}

/** What `startCompileService` should do with a change to `filePath`. */
export type WatchEventKind = 'ignored' | 'package' | 'file'

/**
 * The package branch has to be tested *before* the extension filter, which is
 * the whole bug: `package.json` and `bun.lock` do not end in one of the watched
 * source extensions, so the filter dropped them and the branch below was
 * unreachable. Editing `package.json` in dev produced no log line at all.
 */
export function classifyWatchEvent(filePath: string): WatchEventKind {
  if (watchIgnores.match(filePath)) return 'ignored'
  if (pkgFilesGlob.match(filePath)) return 'package'
  if (!fileTypeGlob.match(filePath)) return 'ignored'
  return 'file'
}

async function processFileEvent(
  filePath: string,
  server: any,
  isDevWorker: boolean,
) {
  if (isDevWorker) {
    if (isBackendPriorityFile(filePath)) {
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

    const kind = classifyWatchEvent(filePath)
    if (kind === 'ignored') continue

    if (kind === 'package') {
      // Log only, no restart — deliberately. `bun install` rewrites the
      // lockfile several times, and restarting on each would put the dev server
      // in a loop for the duration of an install. The line tells you a restart
      // is warranted; you decide when.
      compLog.FILE_STATUS({ status: 'changed', file: filePath })
      continue
    }

    const [error] = await Try.catch(
      processFileEvent(filePath, server, isDevWorker),
    )
    if (error) {
      // A single bad event must not kill the watcher: before this, a throw
      // here unwound the for-await and file watching silently stopped until
      // the next manual restart. The server is alive at this point, so the
      // browser is told too — this is the in-worker sender for the error
      // overlay protocol.
      serveLog.WATCHER_ERR({ error: String(error) })
      notifyError(server, 'Dev watcher error', String(error))
    }
  }
}
