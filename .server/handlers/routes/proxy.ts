import { Bakery } from '@server/core/bakery'
import { handlerLog } from '@server/logger'
import { response } from '@server/utils/http'
import { Handler } from '../core/$base'

export class ProxyHandler extends Handler {
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
        new URL(req.url).search
      break
    }

    if (!proxyUrl) return response.error('Not Found')

    handlerLog.PROXY_REQ({ path, target: proxyUrl })

    const proxyReq = new Request(proxyUrl, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    })

    let proxyRes: Response
    try {
      proxyRes = await fetch(proxyReq)
    } catch {
      return response.error('Bad Gateway', 502)
    }

    const resHeaders = new Headers(proxyRes.headers)
    resHeaders.delete('content-encoding')
    return new Response(proxyRes.body, {
      status: proxyRes.status,
      statusText: proxyRes.statusText,
      headers: resHeaders,
    })
  }
}
