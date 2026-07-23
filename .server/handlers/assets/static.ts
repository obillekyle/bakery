import { Bakery, hostKey } from '@server/core/bakery'
import { toHash } from '@server/utils'
import { fs } from '@server/utils/fs'
import { response } from '@server/utils/http'
import { Handler } from '../core/$base'
import { ErrorHandler } from '../core/$error'

export class StaticHandler extends Handler {
  static canHandle(): boolean {
    return true
  }

  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'static')
  }

  static async handle(path: string) {
    if (Bakery.config.blocked?.match(path)) {
      return response.error('Forbidden', 403)
    }

    const target = fs.resolve(Bakery.serveRoot + path)

    if (
      fs.isForbidden(target, Bakery.serveRoot) ||
      !fs.exists(target) ||
      (await fs.isDir(target))
    ) {
      return response.error('Not Found')
    }

    const file = Bun.file(target)
    const ext = fs.parse(path).ext

    if (fs.isCompressible(ext)) {
      const cacheName = `${toHash(hostKey(path))}${ext}`
      const cached = await fs.getOrCreateCachedFile(
        this.cacheDir,
        cacheName,
        file.lastModified,
        () => file.arrayBuffer(),
      )

      if (cached) return cached
    }

    return file
  }
}

export class DefaultErrorHandler extends ErrorHandler {
  static handle(_path: string, req: Request, error?: Handler.Error.Data) {
    const ip = Bakery.server?.requestIP(req)?.address || 'Unknown'
    const date = new Date().toDateString()

    error ||= this.DEFAULT_ERROR

    const errorPage = `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Error ${error.errorCode} | Bakery 🚀</title>
        </head>
        <body style="margin: 2rem; font-family: sans-serif;">
          <h1>${Bun.escapeHTML(`${error.errorCode} - ${error.errorText}`)}</h1>
          <pre>${Bun.escapeHTML(error.errorBody)}</pre>
          <hr />
          <small>${Bun.escapeHTML(date)} - ${Bun.escapeHTML(ip)}</small>
        </body>
      </html>
    `

    return response.html(errorPage, error.errorCode)
  }
}
