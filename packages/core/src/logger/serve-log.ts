import { Logger, messageLogger } from './logger'

const serveMsgs = {
  STARTING: 'I Starting server in %c{mode}%* mode...',
  STARTING_THREADS:
    'I Starting cluster supervisor with %g{count}%* workers (%creusePort%*)...',
  THREAD_STARTED: 'I [%cWorker #{id}%*] Server running at:',
  RESTART_REQ: 'I Dev server restart requested from %ysync engine%*!',
  // Emitted by the dev worker (cli/dev.ts) when the schema-source hash matches
  // the one recorded after the last successful sync, so the boot-time schema
  // sync is skipped. `--sync` bypasses the skip.
  SCHEMA_SYNC_SKIP:
    'I Schema unchanged since last sync — %yskipping schema sync%* (%c--sync%* forces it)',
  // The skip above is precisely when drift goes unnoticed: schema.ts has not
  // changed, so no sync runs, so nothing looks at the database. Something else
  // altered it — a hand-run ALTER, another environment pointed at the same URL,
  // a restore from an older dump.
  SCHEMA_DRIFT:
    'W %yDatabase no longer matches the last schema Bakery applied%*: {reason}. Run %cdb:history%* to see what was applied, or %cdb:sync --dry-run%* to see what the difference means.',
  UNHANDLED_ERR: 'E Unhandled Server Error: %r{error}%*',
  SHUTTING_DOWN: 'W %yShutting down server...%*',
  BACKEND_CHANGE: 'I Backend change detected: %y{file}%*',
  SERVER_STARTED: 'I %gServer running at:%*',
  SERVER_URL: 'I   ➜ %w{type}%*: %bhttp://{host}:{port}%*',
  WATCHER_ERR: 'E Watcher error: %r{error}%*',
  TSCONFIG_SYNCED:
    'I Synced %ytsconfig.json%* paths with %yserver.config.ts%*!',
  TSCONFIG_PROJECTS_WRITTEN:
    'I Wrote %y{count}%* tsconfig project(s) to %y.cache/tsconfig/%*',
  // One-time repair. Previous releases wired the generated projects into the
  // app's tsconfig.json as `references`, which broke `tsc -p <app>`
  // (TS6305/6306/6310). Named so the rewrite of a tracked file comes with a
  // line saying why it happened.
  TSCONFIG_REFERENCES_REMOVED:
    'I Removed generated %yreferences%* from %ytsconfig.json%* — the %y.cache/tsconfig/%* projects are standalone, and referencing them broke %ytsc -p%*',
  // A plugin asking for a project name that is taken. Named rather than
  // silent: the symptom otherwise is one plugin's types quietly not applying,
  // discovered much later and blamed on the wrong thing.
  TSCONFIG_PROJECT_CLASH:
    'W Plugin %y{plugin}%* wants tsconfig project %y{project}%*, which already exists — %rskipped%*',
  // Degrades to "no types" rather than failing the boot: a missing declaration
  // is a worse editor experience, not a broken server.
  TSCONFIG_FILE_UNRESOLVED:
    'W Could not resolve tsconfig files entry %y{entry}%* — %rskipped%*',
  MANUAL_RELOAD: 'I %yManual reload%* triggered from client logger!',
  CONFIG_IMPORT_ERR: 'E Failed to import %yserver.config.ts%*: %r{error}%*',
  // Multi-line on purpose: a present-but-broken config booting on defaults is
  // the kind of failure a single scrolled-away line hides. DEV only — in PROD
  // the same condition throws out of initConfig() instead of logging.
  CONFIG_BROKEN:
    'E %rserver.config.ts is present but failed to load — booting on built-in defaults (no plugins, no hosts, default port)%*\n  file: %y{file}%*\n{error}',
  // The banner restatement of CONFIG_BROKEN, so the warning survives console
  // scrollback and sits next to the URLs the developer actually reads.
  CONFIG_BROKEN_BANNER:
    'W %rserver.config.ts failed to load%* %y— running on built-in defaults. See the import error above.%*',
  WEBSOCKET_ERR: 'E WebSocket error from %y{ip}%*: %r{error}%*',
  RATE_LIMITED: 'W Rate limited: %y{ip}%*',
  // Emitted instead of RATE_LIMITED when sampling (cli/rate-limit.ts) held
  // lines back; the "30s" must stay in step with RATE_LIMIT_LOG_WINDOW_MS.
  RATE_LIMITED_SUPPRESSED:
    'W Rate limited: %y{ip}%* (%y{count}%* rejections suppressed in the last 30s)',
  // Printed only when the *default* limit is in effect: an unconfigured rate
  // limit silently 429s load tests and shared-NAT offices, so its existence
  // gets one announcement. An app-configured value prints nothing.
  RATE_LIMIT_DEFAULT:
    'I Rate limit: %y{max}%* burst / %y{refill}%* req/s per IP (default) — set %crateLimit: false%* to disable',
  // Multi-worker port sharing rides on kernel-level SO_REUSEPORT load
  // balancing, which only Linux provides; elsewhere N sockets either fail to
  // bind or never receive balanced traffic.
  CLUSTER_CLAMPED:
    'W [Cluster] %y{platform}%* has no kernel-level SO_REUSEPORT load balancing (Linux-only), so %y{requested}%* workers cannot share one port. Running a single worker.',
  WORKER_RESPAWN:
    'W [Cluster] Worker %g{id}%* exited unexpectedly — restarting in %y{delay}%*ms (consecutive failure #%y{failures}%*).',
  // Thread-worker only: the master should hand over the shared memory pool
  // before the worker starts serving; past the deadline the worker serves on
  // its local pool rather than deadlock.
  SHARED_POOL_TIMEOUT:
    'W [Cluster] No shared memory pool from the master within %y{timeout}%*ms — serving on a worker-local pool; cross-worker counters and rate limits will not be shared until it arrives.',
  // The version wipe could not empty the cache directory, so no "current"
  // marker was written and the next boot will try again. Worth a line rather
  // than silence: something is holding those files open, and a stale compiled
  // page surviving an upgrade is the failure the wipe exists to prevent.
  CACHE_WIPE_INCOMPLETE:
    'W Cache directory could not be cleared for the version change — %y{dir}%* still contains %y{files}%*. Retrying on next start; close anything holding those files.',
} as const

export const serveLog = messageLogger(new Logger('serve'), serveMsgs)

const handlerMsgs = {
  // Emitted by `DynamicHandler.executeModule`, which every route handler goes
  // through — an API route, a `.tsx` page and an `error-*.tsx` all land here.
  // It used to say "API module" while printing a `.tsx` path, alongside a
  // `TSX_IMPORT_ERR` that no code ever reached.
  API_IMPORT_ERR: 'E Failed to import route module (%y{file}%*): %r{error}%*',
  // The other half of the same failure: the module *loaded*, and exports no
  // default. `ApiHandler` used to answer that with a bare 404 naming nothing,
  // which reads as "your route file is missing" for a file that is right there.
  API_NO_DEFAULT:
    'E API route has no %cexport default%* (%y{file}%*) — the module loaded but exposes no handler',
  // A handler ran and returned neither a value nor a Response. Still a 404 (see
  // `ApiHandler.handle`), but the log names the file rather than leaving the
  // developer to guess which route answered.
  API_NO_RESPONSE: 'W API route returned no response: %y{file}%*',
  PROXY_REQ: 'I Proxying %y{path}%* -> %b{target}%*',
  MIDDLEWARE_ERR: 'E Middleware error: %r{error}%*',
  BUNDLE_ERR: 'E Failed to bundle module (%y{file}%*): %r{error}%*',
  // **Keep each message one unbroken string literal.** Splitting a long one into
  // `'…' + '…'` types as `string`, so `as const` preserves nothing,
  // `messageLogger` extracts no `{placeholder}`, and every call site fails with
  // "Expected 0 arguments, but got 1". Wrapping the value onto its own line, as
  // below, is fine; joining with `+` is not.
  BUNDLE_SIDE_EFFECTS_REPAIRED:
    'I %y{file}%* tree-shook to an empty export list because its package declares %ysideEffects: false%*; re-bundled through a re-export shim, which keeps the code.',
  BUNDLE_EMPTY_EXPORTS:
    'E %y{file}%* bundled to an export list with no code behind it — every name it exports is undefined, so it is rejected rather than served. The bundler reported success, and re-bundling through a re-export shim did not recover it. Import the specific module you need instead of the package root.',
  BUNDLE_CJS_INTEROP:
    'I Generated named exports for the CommonJS package %y{file}%*, so a named import of it works in the browser.',
  BUNDLE_CJS_PROBED:
    'I Could not read %y{file}%* export names statically, so they were probed by importing it in a short-lived child process.',
  BUNDLE_CJS_DEFAULT_ONLY:
    'W %y{file}%* assigns %ymodule.exports%* wholesale and its members could not be read, so its browser bundle exports only %ydefault%* — a named import from it fails in the browser with "does not provide an export named …", and nothing fails here. Import the default and read the property off it, or use an ESM build.',
} as const

export const handlerLog = messageLogger(new Logger('handlers'), handlerMsgs)

const compileMsgs = {
  FILE_STATUS: 'I File is %y{status}%*: %w{file}%*',
  COMPILE_FAIL: 'E Failed to compile %y{file}%*: %r{error}%*',
  /** Same failure, but for a source string with no originating file. */
  COMPILE_SOURCE_FAIL: 'E Failed to compile inline source: %r{error}%*',
  FILE_DEL: 'I File deleted: %w{file}%*',
} as const

export const compLog = messageLogger(new Logger('compile'), compileMsgs)

const pluginMsgs = {
  UNHANDLED_ERR: 'E Unhandled Plugin Error: %r{error}%*',
  ANALYTICS_STORE_ERR: 'E Analytics store init failed: %r{error}%*',
  DASHBOARD_BUNDLE_ERR: 'E Failed to bundle %ydashboard.js%*: %r{error}%*',
} as const

export const pluginLog = messageLogger(new Logger('plugins'), pluginMsgs)

export const errorMsg = (err: any) => err?.stack || err?.message || String(err)

/**
 * The position record Bun attaches to a transpiler or resolver diagnostic.
 *
 * `BuildMessage` and `ResolveMessage` are the two things Bun throws for a
 * syntax error and an unresolvable import. Neither is `instanceof Error`,
 * neither carries a `stack`, and both report *zero* own enumerable keys — so
 * nothing that inspects a thrown value by spreading it or by `instanceof` sees
 * anything at all. `message`, `name` and `position` are the accessors that
 * actually answer.
 */
type Diagnostic = {
  name?: string
  message?: string
  position?: {
    file?: string
    line?: number
    column?: number
    lineText?: string
  } | null
}

const headline = (err: Diagnostic) => {
  const message = err.message || String(err)
  return err.name && message
    ? `${err.name}: ${message}`
    : message || String(err)
}

function positionLines(position: Diagnostic['position']): string[] {
  if (!position || typeof position !== 'object') return []

  const lines: string[] = []
  const { file, line, column, lineText } = position

  if (file) lines.push(`  at ${file}:${line ?? 0}:${column ?? 0}`)
  else if (line != null) lines.push(`  at line ${line}, column ${column ?? 0}`)

  if (typeof lineText === 'string' && lineText.trim()) {
    lines.push(`  | ${lineText}`)
  }

  return lines
}

/**
 * Everything a thrown value knows about where it came from.
 *
 * `errorMsg` answers `stack || message`, which is the right answer for an
 * `Error` and useless for the diagnostics above: they have no stack, so it
 * degrades to a bare "Expected identifier but found end of file" with no file
 * and no line. This walks `position` instead, and recurses through the
 * `AggregateError.errors` array that `import()`ing a broken `.tsx` throws —
 * that one *is* an `Error`, but it has no stack either, so the summary line
 * ("4 errors building …") was all anyone ever saw.
 *
 * A real `Error` with a real stack still returns exactly `err.stack`, so the
 * existing contract for the common case is unchanged.
 */
export function errorDetail(err: any): string {
  if (!err || typeof err !== 'object') return String(err)
  if (err.stack) return err.stack

  const lines = [headline(err)]

  if (Array.isArray(err.errors) && err.errors.length) {
    for (const sub of err.errors) {
      for (const line of errorDetail(sub).split('\n')) lines.push(`  ${line}`)
    }
    return lines.join('\n')
  }

  lines.push(...positionLines(err.position))
  return lines.join('\n')
}

/**
 * `errorMsg` with the diagnostic's line and column, but not its file.
 *
 * For the log lines whose template already names the file. Bun's own
 * `position.file` is `input.ts` whenever `transform()` was handed a source
 * string rather than a path — which is every compile this codebase does — so
 * printing it beside the real path would contradict it.
 */
export function errorWithPosition(err: any): string {
  const position = (err as Diagnostic)?.position
  if (!position || position.line == null) return errorMsg(err)

  const message = (err as Diagnostic).message || errorMsg(err)
  return `${message} (line ${position.line}, column ${position.column ?? 0})`
}

const toMS = (ns: number) => parseFloat((ns / 1e6).toFixed(2))
export const getElapsed = (start: number) => toMS(Bun.nanoseconds() - start)
