import { compile } from '@server/compiler'
import { Bakery, hostKey } from '@server/core/bakery'
import { toHash } from '@server/utils/common'
import { fs } from '@server/utils/fs'
import { response } from '@server/utils/http'
import { DynamicHandler } from '../core/$dynamic'

const normalizePath = (path: string) =>
  path.endsWith('.js') ? path.slice(0, -3) : path

export class TSHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['ts'],
      dir: Bakery.serveRoot,
    }
  }

  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'ts_cache')
  }

  static async canHandle(path: string, req: Request) {
    if (path.endsWith('.ts')) return true
    return await super.canHandle(normalizePath(path), req)
  }

  static async handle(path: string) {
    const info = await this.resolveRoute(normalizePath(path))
    if (!info) return response.error('Not Found')

    const file = info.file
    const id = toHash(hostKey(info.path))
    const cacheName = `${id}.js`
    const fileOrig = fs.resolve(this.config.dir, info.path)

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      file.lastModified,
      async function compileTS() {
        return await compile(fileOrig)
      },
    )

    return cached || response.error('Compilation Failed')
  }
}
