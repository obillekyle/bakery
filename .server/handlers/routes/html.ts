import { Bakery, hostKey } from '@server/core/bakery'
import { assembleHtml, fs, toHash } from '@server/utils'
import { injectIfHtml, response } from '@server/utils/http'
import type { Handler } from '../core/$base'
import { DynamicHandler } from '../core/$dynamic'
import { DynamicErrorHandler } from '../core/$error'

export class HTMLHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['html'],
      dir: Bakery.serveRoot,
    }
  }

  static canHandle(path: string, req: Request) {
    return path.endsWith('.html') || super.canHandle(path, req)
  }

  static handle = sharedHandler
}

export class HTMLErrorHandler extends DynamicErrorHandler {
  static get config() {
    return {
      ext: ['html'],
      dir: Bakery.serveRoot,
      include: ['**/error.html', '**/error-*.html'],
    }
  }

  static handle = sharedHandler
}

function getCacheDir() {
  return fs.resolve(Bakery.cacheDir, 'html')
}

async function sharedHandler(
  this: typeof DynamicHandler | typeof DynamicErrorHandler,
  path: string,
  req: Request,
  errors?: Handler.Error.Data,
) {
  const errorData = errors || (this as any).DEFAULT_ERROR
  const info = await this.resolveRoute(path, errorData)

  if (!info) return response.error('Not Found')

  const file = info.file

  if (!info.isDynamic && !errorData) {
    const cacheHash = toHash(hostKey(info.path))
    const cacheName = `${cacheHash}.html`

    const cached = await fs.getOrCreateCachedFile(
      getCacheDir(),
      cacheName,
      file.lastModified,
      async () => {
        const content = await file.text()
        return assembleHtml(content)
      },
    )

    if (cached) return cached
  }

  const params = await this.params(req, info.getParams(path) || {})
  const content = await info.file.text()
  const data = { ...params, ...errorData }

  if (import.meta.env.DEV) {
    data.__file = info.path
  }

  const html = await injectIfHtml(content, data)
  return html || response.error('Not Found')
}
