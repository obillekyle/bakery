import { Logger, messageLogger } from './logger'

const serveMsgs = {
  STARTING: 'I Starting server in %c{mode}%* mode...',
  STARTING_THREADS: 'I Starting cluster supervisor with %g{count}%* workers (%creusePort%*)...',
  THREAD_STARTED: 'I [%cWorker #{id}%*] Server running at:',
  START_WATCHER: 'I Starting %yDEV%* watcher...',
  RESTART_REQ: 'I Dev server restart requested from %ysync engine%*!',
  // Emitted by the dev worker (cli/dev.ts) when the schema-source hash matches
  // the one recorded after the last successful sync, so the boot-time schema
  // sync is skipped. `--sync` bypasses the skip.
  SCHEMA_SYNC_SKIP:
    'I Schema unchanged since last sync — %yskipping schema sync%* (%c--sync%* forces it)',
  UNHANDLED_ERR: 'E Unhandled Server Error: %r{error}%*',
  SHUTTING_DOWN: 'W %yShutting down server...%*',
  BACKEND_CHANGE: 'I Backend change detected: %y{file}%*',
  SERVER_STARTED: 'I %gServer running at:%*',
  SERVER_URL: 'I   ➜ %w{type}%*: %bhttp://{host}:{port}%*',
  WATCHER_ERR: 'E Watcher error: %r{error}%*',
  CONFIG_LOADED: 'I Loaded %yserver.config.ts%*',
  TSCONFIG_SYNCED:
    'I Synced %ytsconfig.json%* paths with %yserver.config.ts%*!',
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
} as const

export const serveLog = messageLogger(new Logger('serve'), serveMsgs)

const handlerMsgs = {
  API_IMPORT_ERR: 'E Failed to import API module (%y{file}%*): %r{error}%*',
  TSX_IMPORT_ERR: 'E Failed to import TSX module (%y{file}%*): %r{error}%*',
  TSX_EXPORT_NOT_FUNCTION:
    'E TSX module does not export a function: %y{file}%*',
  PROXY_REQ: 'I Proxying %y{path}%* -> %b{target}%*',
  ERROR_HANDLER_ERR: 'E Error in custom ErrorHandler (%y{name}%*): %r{error}%*',
  CUSTOM_ERROR_PAGE_ERR: 'E Failed to render custom error page: %r{error}%*',
  MIDDLEWARE_ERR: 'E Middleware error: %r{error}%*',
  DISK_CACHE_WRITE_ERR: 'E Failed to write node module disk cache: %r{error}%*',
  BUNDLE_ERR: 'E Failed to bundle module (%y{file}%*): %r{error}%*',
  UNHANDLED_ERR: 'E Unhandled Handler Error: %r{error}%*',
} as const

export const handlerLog = messageLogger(new Logger('handlers'), handlerMsgs)

const compileMsgs = {
  FILE_STATUS: 'I File is %y{status}%*: %w{file}%*',
  COMPILE_FAIL: 'E Failed to compile %y{file}%*: %r{error}%*',
  /** Same failure, but for a source string with no originating file. */
  COMPILE_SOURCE_FAIL: 'E Failed to compile inline source: %r{error}%*',
  COMPILE_OK: 'I Compiled %w{file}%* %gsuccessfully%*.',
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

const toMS = (ns: number) => parseFloat((ns / 1e6).toFixed(2))
export const getElapsed = (start: number) => toMS(Bun.nanoseconds() - start)
