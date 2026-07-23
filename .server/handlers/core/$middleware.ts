import { Bakery } from '@server/core/bakery'
import { NOOP } from '@server/core/config'
import { injectIfHtml } from '@server/utils/http'
import { Handler } from './$base'

export class MiddlewareHandler extends Handler {
  static handlerResult = null as any

  protected static get hasMiddleware() {
    return Boolean(
      Bakery.config.middleware.length || Bakery.config.onRequest !== NOOP,
    )
  }

  static async canHandle(path: string, req: Request) {
    this.handlerResult = await this.handle(path, req)
    return Boolean(this.handlerResult)
  }

  static async handle(_path: string, req: Request) {
    if (this.handlerResult) {
      const res = this.handlerResult
      this.handlerResult = null
      return res
    }

    const intercepted = await Bakery.config.onRequest(req!)
    if (intercepted) return (await injectIfHtml(intercepted)) || undefined

    let data: any

    for (const middleware of Bakery.config.middleware) {
      try {
        const result = await middleware(req, Bakery.server!)
        if (result instanceof Response) {
          data = result
          break
        }
      } catch {
        // silent
      }
    }

    const injectedRes = await injectIfHtml(data)
    return injectedRes || data
  }
}
