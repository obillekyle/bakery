import { log } from '@server/logger'
import { Try } from '@server/utils/common'
import {
  DEFAULT_BLOCKED_GLOBS,
  DEFAULT_DB_BACKUPS,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT,
} from '@server/utils/constants'
import { fs } from '@server/utils/fs'
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
  maxCacheSize: 500,
  importMap: {
    '@client/utils': '.server/client/utils',
  },
  onRequest: NOOP,
  proxy: {},
  rateLimit: DEFAULT_RATE_LIMIT,
  trustProxy: false,
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

export function clearHostConfigCache(): void {
  cachedConfig = null
  hostConfigCache.clear()
}

async function checkCacheVersion(): Promise<void> {
  if (import.meta.env.WORKER) return

  const cacheDir = `${fs.cwd}/.server/.cache`
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

  const serverConfig: any = (await import('../../server.config.ts')).default
  const overriden = { ...defaultConfig, ...serverConfig } as Required<AppConfig>

  overriden.importMap = Object.assign(
    { '@client/*': '.server/client/*' },
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

export function getConfig(): Readonly<ProcessedAppConfig> {
  if (cachedConfig) return cachedConfig

  throw new Error('Config has not been initialized. Call initConfig() first.')
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

export function resolveHostConfig(
  hostname: string,
): Readonly<ProcessedAppConfig> {
  const base = getConfig()
  const hosts = base.hosts
  if (!hosts || !Object.keys(hosts).length) return base

  const cached = hostConfigCache.get(hostname)
  if (cached) return cached

  const entry = hosts[hostname]
  if (!entry) {
    hostConfigCache.set(hostname, base)
    return base
  }

  const merged = mergeHostConfig(base as ProcessedAppConfig, entry)
  hostConfigCache.set(hostname, merged)
  return merged
}
