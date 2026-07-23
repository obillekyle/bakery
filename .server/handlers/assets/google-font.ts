import { Bakery } from '@server/core/bakery'
import { toHash } from '@server/utils/common/case'
import { FileSystem as fs } from '@server/utils/fs'
import { response } from '@server/utils/http'
import { Handler, type Route } from '../core/$base'

export class GoogleFontHandler extends Handler {
  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'gf_cache')
  }

  static canHandle(path: string): boolean {
    return path === '/_gf' || path.startsWith('/_gf/')
  }

  static async handle(path: string, req: Request) {
    if (path.startsWith('/_gf/gstatic/')) {
      const cacheDir = fs.resolve(this.cacheDir, 'gstatic')
      const gstaticPath = path.slice('/_gf/gstatic/'.length)
      const cacheExt = `${fs.parse(gstaticPath).ext || '.bin'}`
      const cacheName = `${toHash(gstaticPath)}${cacheExt}`

      const cached = await fs.getOrCreateCachedFile(
        cacheDir,
        cacheName,
        null,
        async () => {
          const gfUrl = `https://fonts.gstatic.com/${gstaticPath}`
          const res = await fetch(gfUrl)

          if (!res.ok) return null

          return res.arrayBuffer()
        },
      )

      return cached ?? response.error('Failed to fetch Google Fonts asset', 502)
    }

    // Handle CSS stylesheet requests
    const rawPath = path.slice('/_gf'.length)
    const strippedPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
    const gfPath = strippedPath || 'css2'

    const url = new URL(req.url)
    const searchQuery = url.search

    const cacheKey = `${gfPath}${searchQuery}`
    const cacheName = `${toHash(cacheKey)}.css`

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      null,
      async () => {
        const gfUrl = `https://fonts.googleapis.com/${gfPath}${searchQuery}`

        const res = await fetch(gfUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        })

        if (!res.ok) return null

        let css = await res.text()
        css = css.replace(/https?:\/\/fonts\.gstatic\.com/g, '/_gf/gstatic')

        return css
      },
    )

    return cached ?? response.error('Failed to fetch Google Fonts CSS', 502)
  }
}
