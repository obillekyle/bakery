import { Strings } from '../../cache/string'
import { bundleModule } from '../../compiler'
import { Bakery } from '../../core/bakery'
import { frameworkPath } from '../../core/paths'
import type { MapOf } from '../../types'
import { toHash } from '../../utils'
import { FileSystem as fs } from '../../utils/fs'
import { Handler } from '../core/$base'

export class VirtualAssetHandler extends Handler {
  static canHandle(path: string) {
    if (!import.meta.env.DEV && path === '/_client/livereload.js') return false
    return path.startsWith('/_client/') || path.startsWith('/_virtual/')
  }

  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'virtual')
  }

  static get clientAssets(): MapOf<string> {
    // frameworkPath, not Bakery.root: these ship with the framework, so they
    // must resolve relative to it rather than to the application's cwd.
    const assets: MapOf<string> = {
      '/_client/utils.js': frameworkPath('client/utils.ts'),
    }
    if (import.meta.env.DEV) {
      assets['/_client/livereload.js'] = frameworkPath('client/livereload.ts')
    }
    return assets
  }

  static async handleClientAsset(path: string) {
    const masterPath = this.clientAssets[path]
    if (!masterPath) return null

    const masterFile = Bun.file(masterPath)
    if (!fs.exists(masterFile)) return null

    const parsed = fs.parse(masterPath)
    const fileId = `client-${parsed.name}.js`

    const cachedFile = await fs.getOrCreateCachedFile(
      this.cacheDir,
      fileId,
      masterFile.lastModified,
      async function bundleClient() {
        // Bundled, not merely transpiled: these are browser entry points, and
        // the browser cannot resolve the relative imports a transpile leaves
        // behind — they resolve against the page URL, return the HTML
        // fallback, and fail strict MIME checking for module scripts.
        const built = await bundleModule(masterPath as fs.AbsolutePath)
        return built.success && built.content ? built.content : null
      },
    )

    if (!cachedFile) return null

    const routeInfo = new Handler.Route.Info(cachedFile.name!, path.slice(1))

    this.cache.set(path, routeInfo)
    return routeInfo
  }

  static async handleVirtualAsset(path: string) {
    const id = path.slice('/_virtual/'.length)
    const resolvedPath = Strings.getValue(id)
    if (!resolvedPath) return null

    const assetFile = Bun.file(resolvedPath)
    if (!fs.exists(assetFile)) return null

    const ext = fs.parse(resolvedPath).ext
    const cacheName = `${toHash(resolvedPath)}${ext}`

    const cachedFile = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      assetFile.lastModified,
      async function getVirtualAsset() {
        return assetFile.arrayBuffer()
      },
    )

    if (!cachedFile) return null

    const routeInfo = new Handler.Route.Info(cachedFile.name!, path.slice(1))

    this.cache.set(path, routeInfo)
    return routeInfo
  }

  static async getRouteInfo(path: string) {
    if (path.startsWith('/_client/'))
      return await this.handleClientAsset(path)
    if (path.startsWith('/_virtual/'))
      return await this.handleVirtualAsset(path)
  }

  static async handle(path: string) {
    const route = this.cache.get(path)
    if (route?.valid) return route.file

    return (await this.getRouteInfo(path))?.file
  }
}
