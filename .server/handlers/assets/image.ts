import { Bakery } from '@server/core'
import { hostKey } from '@server/core/bakery'
import { errorMsg } from '@server/logger'
import { Math2 } from '@server/utils/common'
import { FileSystem as fs } from '@server/utils/fs'
import { response } from '@server/utils/http'
import { Handler, type Route } from '../core/$base'

const IS_IMAGE_REGEX = /(.*)\/(.*)(;(\d+))?\.(png|jpg|jpeg|webp|gif|bmp)$/i
const IMAGE_CAPTURE = /^(.+?)([^/;.]+)(?:;(\d+))?\.([a-zA-Z0-9]+)$/i

export class ImageHandler extends Handler {
  static maxImageSize = 4096

  static canHandle(path: string): boolean {
    return IS_IMAGE_REGEX.test(path)
  }

  private static lookUpImage(path: string) {
    const key = hostKey(path)
    if (!this.cache.has(key)) return

    const cached = this.cache.get(key) as Route.Info
    const parsed = this.path(path)

    if (parsed) {
      const sourceFile = Bun.file(parsed.source)
      const sourceMtime = sourceFile.lastModified
      const cachedMtime = cached.file.lastModified

      if (sourceMtime && cachedMtime && sourceMtime > cachedMtime) {
        this.cache.delete(key)
        return
      }
    }

    if (fs.exists(cached.file)) return cached

    this.cache.delete(key)
  }

  private static clampSize(size: number) {
    return Math2.clamp(Math2.step(size, 32), 16, this.maxImageSize)
  }

  private static path(path: string) {
    const match = path.match(IMAGE_CAPTURE)
    if (!match) return

    const [_, dir, name, sizeStr, ext] = match
    const size = sizeStr ? parseInt(sizeStr, 10) : null
    const source = fs.resolve(
      Bakery.serveRoot,
      `${dir.slice(1)}/${name}.${ext}`,
    )

    return { dir, name, size, ext, source }
  }

  static async handle(path: string) {
    try {
      const routeInfo = await this.lookUpImage(path)
      if (routeInfo) return routeInfo.file

      const parsed = this.path(path)
      if (!parsed) return response.error('Not Found')

      const { size: sizeStr, source } = parsed
      const size = sizeStr ? this.clampSize(sizeStr) : null

      const sourceFile = Bun.file(source)
      const sourceTime = sourceFile.lastModified

      if (!sourceTime) return response.error('Not Found')

      const cacheDir = fs.resolve(Bakery.cacheDir, 'images')
      const imageCacheId = Bun.hash(hostKey(path)).toString(36)

      await fs.mkdir(cacheDir)

      const masterPath = fs.resolve(cacheDir, `${imageCacheId}-main.webp`)

      let masterFile = Bun.file(masterPath)
      const masterMtime = masterFile.lastModified

      if (!fs.exists(masterFile) || masterMtime < sourceTime) {
        const imgObj = sourceFile.image()
        await imgObj.webp({ quality: 80 }).write(masterPath)
        masterFile = Bun.file(masterPath)
      }

      if (!size) return masterFile

      const cachePath = fs.resolve(cacheDir, `${imageCacheId}-${size}.webp`)
      let cacheFile = Bun.file(cachePath)
      const cacheMtime = cacheFile.lastModified

      if (!fs.exists(cacheFile) || cacheMtime < masterMtime) {
        const imgObj = masterFile.image()
        const meta = await imgObj.metadata()

        const w = meta.width
        const h = meta.height

        const targetSize = Math.min(size, this.maxImageSize)
        const shortest = Math.min(w, h)

        const scale = Math.min(targetSize / shortest, 1)

        const targetW = Math.round(w * scale)
        const targetH = Math.round(h * scale)

        await imgObj.resize(targetW, targetH).write(cachePath)
        cacheFile = Bun.file(cachePath)
      }
      return cacheFile
    } catch (e) {
      return response.error(`Unexpected error: ${errorMsg(e)}`, 500)
    }
  }
}
