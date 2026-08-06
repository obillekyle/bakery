import { Bakery } from '../../core'
import { hostKey } from '../../core/bakery'
import { errorMsg } from '../../logger'
import { Math2 } from '../../utils/common'
import { FileSystem as fs } from '../../utils/fs'
import { response } from '../../utils/http'
import { Handler, type Route } from '../core/$base'
import { getStatic } from '../core/$static'

const IS_IMAGE_REGEX = /(.*)\/(.*)(;(\d+))?\.(png|jpg|jpeg|webp|gif|bmp)$/i
const IMAGE_CAPTURE = /^(.+?)([^/;.]+)(?:;(\d+))?\.([a-zA-Z0-9]+)$/i

export class ImageHandler extends Handler {
  static maxImageSize = 4096

  static canHandle(path: string): boolean {
    return IS_IMAGE_REGEX.test(path)
  }

  private static async lookUpImage(path: string) {
    const key = hostKey(path)
    if (!this.cache.has(key)) return

    const cached = this.cache.get(key) as Route.Info
    const parsed = await this.path(path)

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

  private static async path(path: string) {
    const match = path.match(IMAGE_CAPTURE)
    if (!match) return

    const [_, dir, name, sizeStr, ext] = match
    const size = sizeStr ? parseInt(sizeStr, 10) : null
    const rel = `${dir.slice(1)}/${name}.${ext}`

    // This handler outranks PublicHandler, so the containment and `.forbidden`
    // checks must still apply — otherwise a protected image under public/ is
    // served anyway, despite PublicHandler correctly refusing it. getStatic
    // carries those checks so all the file-serving handlers share one spelling.
    const resolved = await getStatic(`/${rel}`, [
      Bakery.serveRoot,
      Bakery.publicRoot,
    ])

    if (!resolved) return

    const source = resolved.file

    return { dir, name, size, ext, source }
  }

  static async handle(path: string) {
    try {
      const routeInfo = await this.lookUpImage(path)
      if (routeInfo) return routeInfo.file

      const parsed = await this.path(path)
      if (!parsed) return response.error('Not Found')

      const { size: sizeStr, source } = parsed
      const size = sizeStr ? this.clampSize(sizeStr) : null

      const sourceFile = Bun.file(source)
      const sourceTime = sourceFile.lastModified

      if (!sourceTime) return response.error('Not Found')

      const cacheDir = fs.resolve(Bakery.cacheDir, 'images')
      // Key on the resolved source, not the request path. The path carries the
      // caller's raw `;NNN` size suffix *before* clamping, so `;16`, `;17`, `;18`…
      // each produced a distinct id and re-encoded the whole source to WebP —
      // an unbounded cache and unbounded CPU from one image URL.
      const imageCacheId = Bun.hash(hostKey(source)).toString(36)

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
