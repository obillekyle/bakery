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
import { checkCacheVersion } from './cache-version'
import { hostStore } from './context'
import { normalizeMountPath } from './host-mounts'

// Re-exported for the CLI's boot checks, which reach config through this
// subpath; the module itself imports nothing, so it can sit under the router.
export { checkHostMounts } from './host-mounts'

export const NOOP = () => {}

const defaultConfig: Required<AppConfig> = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  maxBodySize: 20 * 1024 * 1024,
  middleware: [],
  backups: DEFAULT_DB_BACKUPS,
  blocked: [],
  // No CORS by default. Not even permissive in development: a framework

  // that quietly allows every origin teaches people it works, then

  // surprises them in production.

  cors: null,
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
  // it (not the route LRUs, not the tiered cache), so it was a knob that
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
  // *path* to give here: the default behavior is the probe itself.
  schema: '',
  // Empty means migrations mode is off, and the schema declarations are the
  // truth that db:sync enforces.
  migrations: '',
  // No store means the built-in one: memory, with bakery/sessions.db behind
  // it. No account key means `Session.endForAccount` has nothing to look up,
  // and says so rather than ending nothing.
  sessions: {},
  root: 'src',
  domains: [],
  hosts: {},
  hostMounts: [],
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
 * construction: in PROD that same condition throws out of `initConfig()`
 * instead of being recorded. Read by `runStartupBanner()` so the warning is
 * restated where the developer is actually looking, not just in scrollback.
 */
export function getConfigLoadError(): string | null {
  return configLoadError
}

/**
 * `hosts` folded to lower case, memoized against the object it came from.
 *
 * Keyed on identity rather than rebuilt per request because `hosts` is frozen
 * for the process lifetime: except under `__setTestConfig`, where a new object
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
  staticDomains = null
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
      // on `defaultConfig` (port 3000, no plugins, no hosts), so the
      // developer debugged the vanished dashboard instead of the config that
      // never parsed. In PROD that boot must not happen: the throw lands in
      // the entry's existing catch (prod.ts / threads.ts / worker.ts), which
      // logs and exits 1. In DEV a crash would just loop the watcher, so boot
      //: loudly, and leave the error for the startup banner to restate.
      const message = errorMsg(error)
      if (import.meta.env.PROD) {
        throw new Error(
          `server.config.ts exists but failed to import: refusing to start on the default config.\n  file: ${configPath}\n${message}`,
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
 * Test seam, symmetric with `__setTestDb` in `@bakery-framework/orm`.
 *
 * The resolved config is frozen, so a test that needs to exercise a
 * config-dependent branch cannot simply assign to it. The alternative was
 * `mock.module('./core/config', …)`, which is process-global and never
 * restored: one file doing that left `Bakery.config` undefined for every test
 * file loaded after it, and the suite stayed green only because Bun happened
 * to order that file last.
 *
 * Always pair with `__resetTestConfig()` in `afterAll`.
 */
export function __setTestConfig(overrides: Partial<ProcessedAppConfig>): void {
  testOverrides = overrides
}

export function __resetTestConfig(): void {
  testOverrides = null
}

/**
 * The config once `initConfig()` has run, and null before it: for code that
 * also runs outside a server, where the defaults are the answer. Sessions are
 * the case: a unit test or a script builds one without booting anything.
 */
export function peekConfig(): Readonly<ProcessedAppConfig> | null {
  return cachedConfig ? getConfig() : null
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
  if (entry.mount !== undefined) {
    merged.mount = normalizeMountPath(entry.mount, 'mount')
  }
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
 * The configured host entries by lowercased key.
 *
 * A Map built from `Object.entries` rather than a lookup on `hosts` itself:
 * own enumerable keys only, so `Host: constructor` cannot reach a prototype
 * member and get merged as if it were a host entry. That is what the previous
 * `Object.hasOwn` guard bought, and it is preserved here.
 *
 * If two keys differ only in case, the first one declared wins.
 */
function hostEntries(hosts: Record<string, HostEntry>): Map<string, HostEntry> {
  if (!hostLookup || hostLookup.source !== hosts) {
    const entries = new Map<string, HostEntry>()
    for (const [key, entry] of Object.entries(hosts)) {
      const normalized = key.toLowerCase()
      if (!entries.has(normalized)) entries.set(normalized, entry)
    }
    hostLookup = { source: hosts, entries }
  }
  return hostLookup.entries
}

/** One label of a domain. */
const DOMAIN_LABEL = /^[a-z0-9_-]+$/

/** An IPv4 address, or what `getHostname` leaves of a bracketed IPv6 one. */
function isIpLiteral(name: string): boolean {
  return name.startsWith('[') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name)
}

/**
 * `value` as a domain, lowercased and without a trailing dot, or null when it
 * is not one. An IP address is not: it has no subdomains to name.
 */
function domainName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const domain = value.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || isIpLiteral(domain)) return null
  return domain.split('.').every(label => DOMAIN_LABEL.test(label))
    ? domain
    : null
}

/** A static `domains` value, normalized once per value. */
let staticDomains: { source: unknown; list: readonly string[] } | null = null

/**
 * The domains `'@'`, `'*'` and bare-label keys are read against: `localhost`
 * and whatever `domains` says, longest first, so a nested one (`bpc.edu.ph`
 * beside `edu.ph`) is tried before the one it sits in. A function is asked
 * each time. An answer that is not a domain is left out, which `checkHosts`
 * refuses at boot for a static one and cannot for a function's.
 */
function appDomains(config: Readonly<ProcessedAppConfig>): readonly string[] {
  const { domains } = config
  const fixed = typeof domains !== 'function'
  if (fixed && staticDomains?.source === domains) return staticDomains.list

  const value = fixed ? domains : domains()
  const given = Array.isArray(value) ? value : value ? [value] : []
  const named = given.map(domainName).filter(d => d !== null)
  const list = [...new Set(['localhost', ...named])].sort(
    (a, b) => b.length - a.length,
  )
  if (fixed) staticDomains = { source: domains, list }
  return list
}

/** What a hostname matched under `hosts`. */
type HostMatch = {
  /** The key that matched, lowercased: what per-entry tables are keyed by. */
  key: string
  /**
   * The tenant: what `hostKey()` prefixes (sessions, file caches) and what a
   * resolved config is cached by. The hostname itself for an exact key, a
   * bare label or `'@'`, which a finite set of keys and domains bounds. For
   * `'*'` it is `*.` and the domain, so made-up subdomains share one tenant
   * instead of each minting a cache bucket and a session namespace.
   */
  tenant: string
  entry: HostEntry
}

/**
 * The `hosts` entry `hostname` is served by, or null for the base config.
 *
 * An exact key first, so every name configured before the other forms
 * existed still matches as it did. Then, under the longest domain the
 * hostname sits in: the domain itself is `'@'`, one label in front of it is
 * that label's key (`admin` for `admin.bpc.edu.ph`), and anything else in
 * front of it is `'*'`. A bare label names one subdomain, not its children:
 * `admin.x.bpc.edu.ph` is `'*'`'s. A hostname under none of the domains, an
 * IP address included, matches only an exact key.
 */
function matchHost(hostname: string): HostMatch | null {
  if (!hostname || !cachedConfig) return null
  const config = getConfig()
  const entries = hostEntries(config.hosts ?? {})
  if (!entries.size) return null
  const name = hostname.toLowerCase().replace(/\.$/, '')

  const exact = entries.get(name)
  if (exact) return { key: name, tenant: name, entry: exact }
  if (isIpLiteral(name)) return null

  for (const domain of appDomains(config)) {
    if (name === domain) {
      const apex = entries.get('@')
      return apex ? { key: '@', tenant: domain, entry: apex } : null
    }
    if (!name.endsWith(`.${domain}`)) continue

    const sub = name.slice(0, -domain.length - 1)
    if (!sub.includes('.') && sub !== '@' && sub !== '*') {
      const named = entries.get(sub)
      if (named) return { key: sub, tenant: name, entry: named }
    }
    const rest = entries.get('*')
    return rest ? { key: '*', tenant: `*.${domain}`, entry: rest } : null
  }
  return null
}

/** The `hosts` key `hostname` matched, lowercased, or `''` for none. */
export function hostEntryKey(hostname: string): string {
  return matchHost(hostname)?.key ?? ''
}

/**
 * Check `domains` and every `hosts` entry's `mount` before anything binds, so
 * a value that cannot mean anything stops the boot and names itself. A
 * `domains` function is asked on each request instead, so its answers cannot
 * be checked here.
 */
export function checkHosts(config: Readonly<ProcessedAppConfig>): void {
  const { domains } = config
  if (typeof domains !== 'function') {
    const listed = Array.isArray(domains)
    const values = listed ? domains : domains ? [domains] : []
    values.forEach((value, i) => {
      if (domainName(value) === null) {
        throw new Error(
          `domains${listed ? `[${i}]` : ''} ${JSON.stringify(value)} is not a domain: labels of letters, digits, '-' and '_' joined by dots, and not an IP address`,
        )
      }
    })
  }
  for (const [key, entry] of Object.entries(config.hosts ?? {})) {
    if (entry?.mount !== undefined) {
      normalizeMountPath(entry.mount, `hosts['${key}'].mount`)
    }
  }
}

/**
 * The tenant `hostname` belongs to (see `HostMatch.tenant`), and `''` when it
 * matches no `hosts` entry, including when no `hosts` are configured at all.
 *
 * Same reasoning as `resolveHostConfig` below, which refuses to cache an
 * unknown hostname: the value arrives on the `Host` header, so anything
 * derived from it that is *kept* (a config entry, a cache key, a file on disk)
 * has to be bounded by the configured set, or an unauthenticated client can
 * grow it without limit. Collapsing unknown hosts to `''` puts them all in one
 * bucket, which is correct because they all get the base config and therefore
 * the same content; `'*'` collapses its subdomains to one tenant per domain
 * for the same reason.
 *
 * Folded with `toLowerCase`: hostnames are case-insensitive (RFC 4343), so
 * `EXAMPLE.com` and `example.com` must be one key, not two. `toLowerCase`,
 * not `toLocaleLowerCase`, which maps `I` to a dotless `ı` in a Turkish
 * locale.
 */
export function resolveHostname(hostname: string): string {
  // No config yet (a unit test that never called `initConfig`) means no `hosts`
  // to match against, which is the same answer as an unconfigured host.
  return matchHost(hostname)?.tenant ?? ''
}

export function resolveHostConfig(
  hostname: string,
): Readonly<ProcessedAppConfig> {
  const base = getConfig()
  const match = matchHost(hostname)
  // An unknown hostname is deliberately not cached: it comes straight from
  // the Host header, so caching misses let any client grow this map one
  // made-up name at a time. A match is cached by its tenant, which the
  // configured keys and domains bound.
  if (!match) return base

  const cached = hostConfigCache.get(match.tenant)
  if (cached) return cached

  const merged = mergeHostConfig(base as ProcessedAppConfig, match.entry)
  hostConfigCache.set(match.tenant, merged)
  return merged
}
