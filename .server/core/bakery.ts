import { fs } from '@server/utils/fs'
import { HandlerMap } from '../handlers/core/$registry'
import { SharedMemoryPool } from '../utils/shared-pool'
import { getConfig } from './config'
import { getBakeryVersion, hostStore } from './context'

export type { HostContext } from './context'
export { hostStore } from './context'

export function hostKey(path: string): string {
  const host = hostStore.getStore()?.hostname || ''
  return host ? `${host}:${path}` : path
}

export function getHostname(req: Request): string {
  if (req.__hostname) return req.__hostname

  let hostname = ''
  const config = getConfig()

  if (config.trustProxy) {
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

  const hosts = config.hosts || {}
  if (hostname && !hosts[hostname] && hostname !== config.host) {
    return new URL(req.url).hostname
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
  root: fs.cwd,
  get version() {
    return getBakeryVersion()
  },
  sharedPool: new SharedMemoryPool(1024 * 1024),
  cacheDir: `${fs.cwd}/.server/.cache`,
  dataDir: `${fs.cwd}/.server/.data`,
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
