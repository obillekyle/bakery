import { Bakery } from '../../core/bakery'
import { handlerLog } from '../../logger'
import { response } from '../../utils/http'
import { parsedUrl } from '../../utils/http/url'
import { Handler } from '../core/$base'

export class ProxyHandler extends Handler {
  /** Answers from an upstream, not from disk. See `Handler.servesFiles`. */
  static servesFiles = false

  static get proxies() {
    return Bakery.config.proxy || {}
  }

  static canHandle(path: string) {
    for (const prefix in this.proxies) {
      if (path.startsWith(prefix)) return true
    }
    return false
  }

  static async handle(path: string, req: Request) {
    let proxyUrl = ''

    for (const [prefix, target] of Object.entries(this.proxies)) {
      if (!path.startsWith(prefix)) continue

      const trailingPath = path.substring(prefix.length)
      const baseTarget = target.endsWith('/') ? target.slice(0, -1) : target
      proxyUrl =
        baseTarget +
        (trailingPath.startsWith('/') ? '' : '/') +
        trailingPath +
        parsedUrl(req).search
      break
    }

    if (!proxyUrl) return response.error('Not Found')

    handlerLog.PROXY_REQ({ path, target: proxyUrl })

    // Don't hand a third-party upstream the caller's credentials. `host` is
    // dropped so fetch derives it from the target URL rather than ours.
    const headers = new Headers(req.headers)
    for (const h of ['cookie', 'authorization', 'host', 'sec-fetch-site']) {
      headers.delete(h)
    }

    const proxyReq = new Request(proxyUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    })

    let proxyRes: Response
    try {
      // Manual redirects: following one automatically would re-attach these
      // headers to whatever host the upstream names, including link-local IPs.
      proxyRes = await fetch(proxyReq, { redirect: 'manual' })
    } catch {
      return response.error('Bad Gateway', 502)
    }

    const resHeaders = new Headers(proxyRes.headers)
    // Bun already decompressed the body, so the upstream's content-encoding is
    // wrong — and so is its content-length, which described the compressed size.
    resHeaders.delete('content-encoding')
    resHeaders.delete('content-length')
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: resHeaders,
    })
  }
}
