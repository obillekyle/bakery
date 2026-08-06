import { bundleModule } from '../../compiler'
import { Bakery } from '../../core/bakery'
import { toHash } from '../../utils/common'
import { fs } from '../../utils/fs'
import { Handler } from '../core/$base'

export class NMHandler extends Handler {
  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'nm_cache')
  }

  static canHandle(path: string) {
    return path.startsWith('/_nm/')
  }

  static async handle(path: string) {
    const nmPath = path.replace(/^\/_nm\//, 'node_modules/')
    const nodeModulesPath = fs.resolve(Bakery.root, nmPath)
    const expectedPrefix = `${fs.resolve(Bakery.root, 'node_modules/')}/`
    if (!nodeModulesPath.startsWith(expectedPrefix)) return undefined
    const nmFile = Bun.file(nodeModulesPath)
    const sourceMtime = fs.exists(nmFile) ? nmFile.lastModified : null

    const cacheId = toHash(nmPath)
    const cacheName = `${cacheId}.js`

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      sourceMtime,
      async () => {
        const module = await bundleModule(nodeModulesPath)
        return module.success && module.content ? module.content : null
      },
    )

    return cached || undefined
  }
}
