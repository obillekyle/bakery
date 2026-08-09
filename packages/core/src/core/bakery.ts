import { HandlerMap } from '../handlers/core/$registry'
import { fs } from '../utils/fs'
import { SharedMemoryPool } from '../utils/shared-pool'
import { getConfig, resolveHostname } from './config'
import { getBakeryVersion, hostStore } from './context'

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
    return getBakeryVersion()
  },
  sharedPool: new SharedMemoryPool(1024 * 1024),
  // The disposable directory is the hidden one, and the precious one is not.
  // This is the reverse of the old `.bakery/cache` + `.data` pairing, and the
  // reversal is the whole point: `.cache` is wiped by the framework itself on
  // every version bump and dev<->prod switch, so a `rm -rf .*` or a "clean out
  // the dotfiles" sweep does exactly what the framework already does. The
  // database is not disposable, so it does not live behind a leading dot where
  // such a sweep can reach it.
  cacheDir: `${fs.cwd}/.cache`,
  // Holds the database and its backups. Visible, and deliberately not under
  // `.cache`: clearing a cache must never be able to destroy data.
  dataDir: `${fs.cwd}/bakery`,
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
