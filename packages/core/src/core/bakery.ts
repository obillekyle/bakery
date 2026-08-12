import { HandlerMap } from '../handlers/core/$registry'
import { fs } from '../utils/fs'
import { SharedMemoryPool } from '../utils/shared-pool'
import { getConfig, resolveHostname } from './config'
import { cacheDir, dataDir, getAppVersion, hostStore } from './context'

export type { HostContext } from './context'
export { hostStore } from './context'

/**
 * Namespace a cache key by the current host.
 *
 * The hostname is resolved against `config.hosts` first, and an unconfigured
 * one collapses to the unprefixed key. That is not cosmetic: this key becomes a
 * **filename** in five handlers, and `getOrCreateCachedFile` writes three files
 * per entry with no bound and no eviction. Prefixing the raw `Host` header let
 * any client mint an unlimited number of cache entries — 25 requests for one
 * path under 25 made-up hostnames took the cache directory from 9 files to 84.
 *
 * `resolveHostConfig` already carries this reasoning for the config cache; the
 * file caches simply never got it. Collapsing is safe because an unconfigured
 * host is served the base config, so its content is identical to the default
 * bucket's.
 */
export function hostKey(path: string): string {
  const host = resolveHostname(hostStore.getStore()?.hostname || '')
  return host ? `${host}:${path}` : path
}

export function getHostname(
  req: Request,
  config?: Readonly<ProcessedAppConfig>,
): string {
  if (req.__hostname) return req.__hostname

  let hostname = ''
  const cfg = config ?? Bakery.config

  if (cfg.trustProxy) {
    const forwardedHost = req.headers.get('x-forwarded-host')
    if (forwardedHost) {
      hostname = forwardedHost.split(',')[0].trim().split(':')[0]
    }
  }

  if (!hostname) {
    const hostHeader = req.headers.get('host')
    if (hostHeader) hostname = hostHeader.split(':')[0]
    else hostname = new URL(req.url).hostname
  }

  return hostname
}

export const Bakery: globalThis.Bakery = {
  get config(): Readonly<ProcessedAppConfig> {
    return hostStore.getStore()?.config ?? getConfig()
  },
  get serveRoot() {
    return this.config.root
  },
  get apiRoot() {
    return fs.resolve(this.serveRoot, 'api')
  },
  get publicRoot() {
    return fs.resolve(Bakery.root, 'public')
  },
  root: fs.cwd,
  get version() {
    return getAppVersion()
  },
  sharedPool: new SharedMemoryPool(1024 * 1024),
  // Defined in `core/context.ts`, which is low enough that a module needing a
  // path does not have to import `Bakery` to get one — reaching them through
  // here is what closed the logger cycle. These stay the reading surface for
  // application and framework code; context is the single definition.
  //
  // Called here rather than forwarded through a getter, so these remain plain
  // writable properties: `nm.test.ts` repoints them at a fixture tree, which a
  // getter turns into `TypeError: Attempted to assign to readonly property`.
  cacheDir: cacheDir(),
  dataDir: dataDir(),
  startNs: Bun.nanoseconds(),
  handlers: {
    fetch: new HandlerMap(),
    error: new HandlerMap(),
    websocket: new HandlerMap(),
  },
  shutdownHooks: [] as any[],
  onShutdown(hook: () => Promise<void> | void) {
    this.shutdownHooks.push(hook)
  },
}

export default Bakery
