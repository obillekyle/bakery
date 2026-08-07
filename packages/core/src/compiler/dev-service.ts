import { watch } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { initRoutes } from '../cache'
import { Bakery } from '../core/bakery'
import { isDevWorker } from '../core/init'
// Dependency-free by construction (see the note above about not dragging the
// handler or plugin runtime into this graph): `core/port` imports nothing.
import { resolvePort } from '../core/port'
import { Try } from '../utils'
import { Glob, fs } from '../utils/fs'
import { compLog, serveLog } from '../logger'
import { PromptTracker } from './prompt-tracker'
// Type-only: the compiler must not pull the handler or plugin runtime into the
// dev worker's module graph, and nothing here needs a value from either.
import type { Handler } from '../handlers/core/$base'
import type { ServerPlugin } from '../plugins/types'

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
 *
 * Two producers reach here. The watcher's `catch` below sends internal watcher
 * faults directly; every *request-time* failure arrives through `emitDevError`
 * and the sink `startCompileService` installs. That second producer is the
 * point of the whole apparatus — for a long time only the first existed, so the
 * overlay was reachable solely on an IO fault inside the watcher loop and never
 * appeared for the failures developers actually hit.
 */
export function notifyError(server: any, title: string, body: string) {
  server?.publish('livereload', JSON.stringify({ type: 'error', title, body }))
}

/**
 * Longest error body that may cross the livereload socket.
 *
 * `errorBody` is a stack for anything `extractErrorData` builds from a thrown
 * `Error`, and a framework-deep throw produces tens of kilobytes of it. The
 * overlay renders it into a single `<pre>`, so past a screenful the extra bytes
 * are unreadable *and* re-broadcast to every connected tab on every failing
 * request.
 */
export const MAX_DEV_ERROR_BODY = 8000

/** Name the dev overlay plugin registers under; also its dedupe key. */
export const DEV_ERROR_PLUGIN = 'bakery:dev-error-overlay'

/**
 * Whether a request-time failure earns the full-screen dev overlay.
 *
 * 4xx is deliberately excluded. A 404 for a mistyped URL or an absent
 * `favicon.ico` is the router working as designed, and covering the page for it
 * would train developers to dismiss the overlay reflexively — which is how the
 * feature dies a second time. 5xx is the band that means "your code, or the
 * framework, broke", and that is the band this overlay exists for.
 *
 * A record with no usable `errorCode` is treated as 500: `extractErrorData`
 * fills that field on every path it owns, so the only way to arrive without one
 * is a malformed record, and surfacing that beats swallowing it.
 */
export function classifyDevError(
  error: Partial<Handler.Error.Data> | null | undefined,
): 'overlay' | 'ignore' {
  const code = typeof error?.errorCode === 'number' ? error.errorCode : 500
  return code >= 500 ? 'overlay' : 'ignore'
}

/**
 * The request path an error belongs to, or `''` when it cannot be determined.
 *
 * `handleRequestError` substitutes `http://localhost/__internal__` for a
 * missing request, which names nothing the developer can act on, so it is
 * reported as unknown rather than as a route.
 */
function devErrorRequestPath(req?: { url?: string } | null): string {
  const url = req?.url
  if (!url) return ''
  const parsed = Try(() => new URL(url))
  if (!parsed) return ''
  return parsed.pathname === '/__internal__' ? '' : parsed.pathname
}

/**
 * An error record rendered into the `{title, body}` the overlay draws.
 *
 * Pure, and separate from the publish so the shape is pinned by tests without
 * a server. The path goes in the *title* on purpose: the body is a stack whose
 * first frames are usually framework internals, and "which request did this"
 * is the one thing the developer needs before reading any of it.
 */
export function formatDevErrorFrame(
  error: Partial<Handler.Error.Data> | null | undefined,
  req?: { url?: string } | null,
): { title: string; body: string } {
  const code = typeof error?.errorCode === 'number' ? error.errorCode : 500
  const text = error?.errorText || 'Internal Server Error'
  const path = devErrorRequestPath(req)
  const body = String(error?.errorBody ?? '')

  return {
    title: path ? `${code} ${text} — ${path}` : `${code} ${text}`,
    body:
      body.length > MAX_DEV_ERROR_BODY
        ? `${body.slice(0, MAX_DEV_ERROR_BODY)}\n… truncated`
        : body,
  }
}

/**
 * Where a dev error goes, once something has said where that is.
 *
 * The producer of request-time errors (the plugin below, running inside a
 * request) and the thing that owns the `Bun.Server` (`startCompileService`)
 * are on opposite sides of the process, and neither may import the other's
 * concerns: the router and the error handlers must not learn about the
 * compiler. So the compiler pushes a publisher in here, and everything else
 * emits through a hook that is a no-op until it does.
 *
 * Null in PROD, in a cluster worker, and in every test that does not install
 * one — `emitDevError` is then a single optional call and nothing else runs.
 */
let devErrorSink: ((title: string, body: string) => void) | null = null

/** Install (or, with `null`, remove) the dev error publisher. */
export function setDevErrorSink(
  sink: ((title: string, body: string) => void) | null,
): void {
  devErrorSink = sink
}

/** Publish a dev error, or do nothing at all if no sink is installed. */
export function emitDevError(title: string, body: string): void {
  devErrorSink?.(title, body)
}

/**
 * The dev-only plugin that carries request-time failures to the overlay.
 *
 * `ServerPlugin.onError` is the framework's own observation point for request
 * errors: `router.ts handleRequestError` calls it first, before the plugin
 * response check, before `config.onError`, and before the error-handler
 * registry — so it sees every failure the error path sees (thrown handler,
 * 5xx `Response`, and Bun's `error()` callback), with `errorBody` still holding
 * the full stack. Using it is what lets the overlay be wired without router.ts
 * or the error handlers ever hearing about the compiler.
 *
 * It returns `undefined` unconditionally. `PluginHooks.onError` treats that as
 * "no opinion" and carries on down the list, so registering this cannot change
 * which page a failing request answers with — it only observes.
 */
export function createDevErrorPlugin(): ServerPlugin {
  return {
    name: DEV_ERROR_PLUGIN,
    onError(error, req) {
      if (classifyDevError(error) === 'overlay') {
        const frame = formatDevErrorFrame(error, req)
        emitDevError(frame.title, frame.body)
      }
      // Observer, never an answer. See the note above.
      return undefined
    },
  }
}

/**
 * Put the overlay plugin at the front of the plugin list.
 *
 * *Front*, not back: `PluginHooks.onError` stops at the first plugin that
 * returns a response, so an app plugin that answers errors itself would
 * otherwise hide every failure from the overlay. This one never answers, so
 * running it first costs the others nothing.
 *
 * The array is mutated in place because `initConfig` hands back a frozen
 * config — `config.plugins = [...]` would throw, and the array itself is the
 * only writable seam. Host configs are built with `{...base}` and never
 * override `plugins`, so every host shares this exact array and one
 * registration covers all of them. Idempotent by name, because a re-registration
 * would double every frame.
 */
export function registerDevErrorOverlay(
  plugins: unknown = Bakery.config.plugins,
): 'registered' | 'duplicate' | 'unavailable' {
  if (!Array.isArray(plugins)) return 'unavailable'
  if (plugins.some(p => p?.name === DEV_ERROR_PLUGIN)) return 'duplicate'

  // A config may legitimately hand over a frozen array; that is a reason to
  // skip the overlay, not to take the dev server down.
  const added = Try(() => plugins.unshift(createDevErrorPlugin()))
  return added === null ? 'unavailable' : 'registered'
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

  // Shared with `worker.ts` (which binds) and `startup.ts` (which prints the
  // banner), so the URL this master advertises cannot drift from the port its
  // worker listens on. A malformed `PORT` throws here rather than in the
  // spawned worker: the dev master is the process the developer is watching,
  // and `cli/index.ts`'s bootstrap catch turns it into one clear fatal line.
  const port = resolvePort(config.port)
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
  // The framework's own cache directory (`Bakery.cacheDir`).
  '**/.cache/**/*',
  // `bakery/` (`Bakery.dataDir`) holds the database plus
  // `backups/schema.<timestamp>.ts` files the DB backup writes at runtime —
  // without this, taking a backup while the dev server ran flushed the route
  // cache and reloaded the browser. It is un-dotted on purpose (see
  // `core/bakery.ts`), which is exactly why it has to be named here: a
  // "skip the dotfiles" heuristic would no longer cover it.
  '**/bakery/**/*',
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
 * under `.cache/` after a *successful* sync only, and consults this
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
  /** The local database file is gone (e.g. `bakery/` deleted to reset). */
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

/** Route modules reached through `import()`, whose resolution Bun caches. */
const MODULE_ROUTE_EXT = /\.(tsx|jsx)$/

/**
 * Whether this event is the *creation* of a route module, which needs a
 * restart where an edit does not.
 *
 * Editing a `.tsx` page is instant: the page module carries a `?v=<mtime>`
 * specifier, so Bun re-imports it and the change is served on the next
 * request. Creating one is not — Bun caches the *directory listing* it
 * resolved against, so a file that did not exist at boot fails to import at
 * any specifier, including a freshly-stamped one. The page 500s with
 * `Cannot find module '<path>?v=<mtime>'` until the process restarts. That is
 * a regression from taking `.tsx` off the restart path for fast edits: API
 * routes never showed it because a new `.ts` under `apiRoot` is a backend
 * change and restarts already.
 *
 * `rename` is the creation signal. Measured on Windows: an in-place write
 * (`Bun.write`, `fs.writeFile`) emits only `change` and keeps the fast path —
 * 14-15ms edit-to-served — while creating a file emits `rename` then
 * `change`. Writers that replace rather than overwrite report `rename` for an
 * *edit* too and pay one restart (~440ms): shell redirection (`> file`) does
 * this, and an editor that saves atomically will as well. That is the safe
 * direction to be wrong in — a slower save beats a page that does not serve
 * at all — but it is why this is scoped as narrowly as possible.
 * Deletes are `rename` with no file, and need no restart.
 *
 * Scoped to imported modules: a new `.html`, `.css` or client `.ts` is read or
 * transpiled from disk rather than imported, and already works untouched.
 */
export function isCreatedRouteModule(
  filePath: string,
  eventType: string,
  exists: boolean,
): boolean {
  if (eventType !== 'rename' || !exists) return false
  return MODULE_ROUTE_EXT.test(filePath)
}

async function processFileEvent(
  filePath: string,
  server: any,
  isDevWorker: boolean,
  eventType = 'change',
) {
  if (isDevWorker) {
    if (isBackendPriorityFile(filePath)) {
      serveLog.BACKEND_CHANGE({ file: filePath })
      return process.exit(42)
    }

    // Checked before the cheap path below: a *new* page cannot be imported by
    // this process at all — see `isCreatedRouteModule`.
    if (
      isCreatedRouteModule(
        filePath,
        eventType,
        await Bun.file(filePath).exists(),
      )
    ) {
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

  // Only the dev worker serves `/_livereload` (LiveReloadHandler.canHandle
  // gates on DEV && DEV_WORKER), so only the dev worker has anywhere to publish
  // to. Everywhere else the sink stays null and the plugin is never registered,
  // which is what keeps this off the production path entirely.
  if (isDevWorker) {
    setDevErrorSink((title, body) => notifyError(server, title, body))
    if (registerDevErrorOverlay() === 'unavailable') {
      // Not fatal: hot reload and the watcher-fault overlay still work, the
      // request-time overlay just will not appear. Say so rather than leaving
      // the developer to wonder why it never shows.
      serveLog.WATCHER_ERR({
        error:
          'dev error overlay not registered: config.plugins is not writable',
      })
    }
  }

  for await (const { filename, eventType } of watcher) {
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
      processFileEvent(filePath, server, isDevWorker, eventType),
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
