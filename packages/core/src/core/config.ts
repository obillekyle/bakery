import { log } from '../logger'
import { errorMsg, serveLog } from '../logger/serve-log'
import { Try } from '../utils/common'
import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_DB_BACKUPS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
} from '../utils/constants'
import { fs } from '../utils/fs'
import { getBakeryVersion, hostStore } from './context'

export const NOOP = () => {}

const defaultConfig: Required<AppConfig> = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  maxBodySize: 20 * 1024 * 1024,
  middleware: [],
  backups: DEFAULT_DB_BACKUPS,
  blocked: [],
  head: '',
  body: '',
  plugins: [],
  onStart: NOOP,
  onError(e) {
    const host = hostStore.getStore()?.hostname || 'global'
    log({ level: 'warn', by: host, msg: e.errorBody })
  },
  onShutdown: NOOP,
  // `maxCacheSize: 500` used to sit here. Nothing in the framework ever read
  // it — not the route LRUs, not the tiered cache — so it was a knob that
  // typechecked, appeared in completion, and did nothing. Removed from
  // `AppConfig` at the same time; `defaultConfig` is `Required<AppConfig>`, so
  // the two can only move together.
  importMap: {
    // Served by VirtualAssetHandler; the framework's own files are no longer
    // reachable at an app-relative '.server/...' path.
    '@client/utils': '/_client/utils.js',
  },
  onRequest: NOOP,
  proxy: {},
  rateLimit: DEFAULT_RATE_LIMIT,
  trustProxy: false,
  // Empty means auto-detect, matching `head`/`body` above. There is no default
  // *path* to give here: the default behaviour is the probe itself.
  schema: '',
  root: 'src',
  hosts: {},
  websocket: {
    message: NOOP,
    open: NOOP,
    close: NOOP,
    drain: NOOP,
  },
}

let cachedConfig: ProcessedAppConfig | null = null
const hostConfigCache = new Map<string, Readonly<ProcessedAppConfig>>()

let configLoadError: string | null = null

/**
 * The import failure recorded by the most recent `initConfig()` run, when a
 * `server.config.ts` was *present but failed to load*. DEV-only by
 * construction — in PROD that same condition throws out of `initConfig()`
 * instead of being recorded. Read by `runStartupBanner()` so the warning is
 * restated where the developer is actually looking, not just in scrollback.
 */
export function getConfigLoadError(): string | null {
  return configLoadError
}

/**
 * `hosts` folded to lower case, memoised against the object it came from.
 *
 * Keyed on identity rather than rebuilt per request because `hosts` is frozen
 * for the process lifetime — except under `__setTestConfig`, where a new object
 * arrives and the identity check rebuilds rather than serving a stale map.
 */
let hostLookup: {
  source: Record<string, HostEntry>
  entries: Map<string, HostEntry>
} | null = null

export function clearHostConfigCache(): void {
  cachedConfig = null
  hostConfigCache.clear()
  hostLookup = null
}

async function checkCacheVersion(): Promise<void> {
  if (import.meta.env.WORKER) return

  const cacheDir = `${fs.cwd}/.bakery/cache`
  const serverJsonPath = `${cacheDir}/server.json`
  const currentMode = import.meta.env.DEV ? 'development' : 'production'
  const currentVersion = getBakeryVersion()

  const [err, prev] = await Try.catch(() => Bun.file(serverJsonPath).json())
  if (
    err ||
    !prev ||
    prev.mode !== currentMode ||
    prev.version !== currentVersion
  ) {
    if (fs.exists(cacheDir)) {
      await fs.rm(cacheDir, { recursive: true, force: true })
    }
    if (!fs.exists(cacheDir)) {
      await fs.mkdir(cacheDir)
    }
    await Bun.write(
      serverJsonPath,
      JSON.stringify({ mode: currentMode, version: currentVersion }, null, 2),
    )
  }
}

export async function initConfig(): Promise<Readonly<ProcessedAppConfig>> {
  if (cachedConfig) return cachedConfig

  await checkCacheVersion()
  hostConfigCache.clear()

  // Resolved against the application's cwd, not relative to this file. A
  // static '../../server.config.ts' reached out of the framework into the app,
  // which breaks as soon as the framework is a package rather than a directory
  // inside the app. Absence is tolerated: the defaults below are a usable
  // config, and zero-config boot is a supported feature.
  const configPath = fs.resolve(process.cwd(), 'server.config.ts')
  let serverConfig: any = {}
  configLoadError = null

  if (await Bun.file(configPath).exists()) {
    const [error, loaded] = await Try.catch(import(configPath))
    if (error) {
      // Present-but-broken is not absence. This used to log one line and boot
      // on `defaultConfig` — port 3000, no plugins, no hosts — so the
      // developer debugged the vanished dashboard instead of the config that
      // never parsed. In PROD that boot must not happen: the throw lands in
      // the entry's existing catch (prod.ts / threads.ts / worker.ts), which
      // logs and exits 1. In DEV a crash would just loop the watcher, so boot
      // — loudly, and leave the error for the startup banner to restate.
      const message = errorMsg(error)
      if (import.meta.env.PROD) {
        throw new Error(
          `server.config.ts exists but failed to import — refusing to start on the default config.\n  file: ${configPath}\n${message}`,
        )
      }
      configLoadError = message
      serveLog.CONFIG_BROKEN({ file: configPath, error: message })
    } else {
      serverConfig = loaded?.default ?? {}
    }
  }
  const overriden = { ...defaultConfig, ...serverConfig } as Required<AppConfig>

  overriden.importMap = Object.assign(
    { '@client/utils': '/_client/utils.js' },
    serverConfig.importMap || {},
  )

  const blockedGlob = [
    ...DEFAULT_BLOCKED_GLOBS,
    ...overriden.blocked.map(pattern =>
      pattern.startsWith('**/') ? pattern : `**/${pattern}`,
    ),
  ].join(',')

  cachedConfig = Object.assign(overriden, {
    blocked: new Bun.Glob(`{${blockedGlob}}`),
    root: fs.resolve(overriden.root),
  })

  return Object.freeze(cachedConfig)
}

let testOverrides: Partial<ProcessedAppConfig> | null = null

/**
 * Test seam, symmetric with `__setTestDb` in `@bakery/orm`.
 *
 * The resolved config is frozen, so a test that needs to exercise a
 * config-dependent branch cannot simply assign to it. The alternative was
 * `mock.module('./core/config', …)`, which is process-global and never
 * restored — one file doing that left `Bakery.config` undefined for every test
 * file loaded after it, and the suite stayed green only because Bun happened
 * to order that file last.
 *
 * Always pair with `__resetTestConfig()` in `afterAll`.
 */
export function __setTestConfig(
  overrides: Partial<ProcessedAppConfig>,
): void {
  testOverrides = overrides
}

export function __resetTestConfig(): void {
  testOverrides = null
}

export function getConfig(): Readonly<ProcessedAppConfig> {
  if (!cachedConfig) {
    throw new Error('Config has not been initialized. Call initConfig() first.')
  }

  if (testOverrides) {
    return Object.freeze({ ...cachedConfig, ...testOverrides })
  }

  return cachedConfig
}

function mergeHostConfig(
  base: ProcessedAppConfig,
  entry: HostEntry,
): Readonly<ProcessedAppConfig> {
  const merged: any = { ...base }

  if (entry.root) merged.root = fs.resolve(entry.root)
  if (entry.importMap)
    merged.importMap = { ...base.importMap, ...entry.importMap }
  if (entry.middleware) merged.middleware = entry.middleware
  if (entry.onRequest) merged.onRequest = entry.onRequest
  if (entry.onError) merged.onError = entry.onError
  if (entry.head !== undefined) merged.head = entry.head
  if (entry.body !== undefined) merged.body = entry.body
  if (entry.proxy) merged.proxy = entry.proxy
  if (entry.rateLimit !== undefined) merged.rateLimit = entry.rateLimit
  if (entry.blocked) {
    const blockedGlob = [
      ...DEFAULT_BLOCKED_GLOBS,
      ...entry.blocked.map(p => (p.startsWith('**/') ? p : `**/${p}`)),
    ].join(',')
    merged.blocked = new Bun.Glob(`{${blockedGlob}}`)
  }

  return Object.freeze(merged)
}

/**
 * The configured host entry for an already-lowercased hostname, or undefined.
 *
 * A Map built from `Object.entries` rather than a lookup on `hosts` itself:
 * own enumerable keys only, so `Host: constructor` cannot reach a prototype
 * member and get merged as if it were a host entry. That is what the previous
 * `Object.hasOwn` guard bought, and it is preserved here.
 *
 * If two keys differ only in case, the first one declared wins.
 */
function lookupHostEntry(
  hosts: Record<string, HostEntry>,
  hostname: string,
): HostEntry | undefined {
  if (!hostLookup || hostLookup.source !== hosts) {
    const entries = new Map<string, HostEntry>()
    for (const [key, entry] of Object.entries(hosts)) {
      const normalized = key.toLowerCase()
      if (!entries.has(normalized)) entries.set(normalized, entry)
    }
    hostLookup = { source: hosts, entries }
  }

  return hostLookup.entries.get(hostname)
}

/**
 * The canonical form of `hostname` if the app declares it under `hosts`, and
 * `''` otherwise — including when no `hosts` are configured at all.
 *
 * Same reasoning as `resolveHostConfig` below, which already refuses to cache
 * an unknown hostname: the value arrives on the `Host` header, so anything
 * derived from it that is *kept* — a config entry, a cache key, a file on disk
 * — has to be bounded by the configured set, or an unauthenticated client can
 * grow it without limit. Collapsing unknown hosts to `''` puts them all in one
 * bucket, which is correct because they all get the base config and therefore
 * the same content.
 *
 * Folded with `toLowerCase` for the reason spelled out below: hostnames are
 * case-insensitive, so `EXAMPLE.com` and `example.com` must be one key, not two.
 */
export function resolveHostname(hostname: string): string {
  // No config yet (a unit test that never called `initConfig`) means no `hosts`
  // to match against, which is the same answer as an unconfigured host.
  if (!hostname || !cachedConfig) return ''
  const hosts = getConfig().hosts
  if (!hosts) return ''
  const key = hostname.toLowerCase()
  return lookupHostEntry(hosts, key) ? key : ''
}

export function resolveHostConfig(
  hostname: string,
): Readonly<ProcessedAppConfig> {
  const base = getConfig()
  const hosts = base.hosts
  if (!hosts || !Object.keys(hosts).length) return base

  // Hostnames are case-insensitive (RFC 4343) and nothing upstream normalises
  // the Host header, so a request to `EXAMPLE.com` used to miss an
  // `example.com` entry and silently fall back to the base config. Both sides
  // fold to lower case — `toLowerCase`, not `toLocaleLowerCase`, which would
  // map `I` to a dotless `ı` in a Turkish locale.
  const key = hostname.toLowerCase()

  const cached = hostConfigCache.get(key)
  if (cached) return cached

  const entry = lookupHostEntry(hosts, key)
  if (!entry) {
    // Deliberately NOT cached. The hostname comes straight from the Host
    // header, so caching unknown values let any client grow this map without
    // bound — one request per made-up hostname until the process runs out of
    // memory. Known hosts are a fixed, small set, so only those are cached.
    // Normalising above keeps that bound honest: without it, `EXAMPLE.com` and
    // `example.com` would occupy two entries for one configured host.
    return base
  }

  const merged = mergeHostConfig(base as ProcessedAppConfig, entry)
  hostConfigCache.set(key, merged)
  return merged
}
