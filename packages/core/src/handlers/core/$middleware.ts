import { Bakery } from '../../core/bakery'
import { NOOP } from '../../core/config'
import { errorMsg, handlerLog } from '../../logger/serve-log'
import { injectIfHtml, response } from '../../utils/http'
import { Handler } from './$base'

/**
 * Per-request slot for the response produced during `canHandle`, so `handle`
 * can return it without re-running the chain. This was previously a static
 * field, which meant two concurrent requests could swap responses — including
 * each other's `Set-Cookie` headers — at any `await` boundary.
 */
const pending = new WeakMap<Request, Response>()

export class MiddlewareHandler extends Handler {
  /**
   * `canHandle` here means "was this request denied", which is a fact about
   * the request and not about the path. Without this the route cache would
   * serve the page handler that the first *allowed* request resolved to,
   * and every later request to that path would skip middleware entirely.
   */
  static override alwaysResolve = true

  protected static get hasMiddleware() {
    // One read of the config getter (an AsyncLocalStorage getStore), not two.
    const config = Bakery.config
    return Boolean(config.middleware.length || config.onRequest !== NOOP)
  }

  static async canHandle(path: string, req: Request) {
    const result = await this.handle(path, req)
    if (result) pending.set(req, result)
    return Boolean(result)
  }

  static async handle(_path: string, req: Request) {
    const cached = pending.get(req)
    if (cached) {
      pending.delete(req)
      return cached
    }

    // One config read for both `onRequest` and the middleware chain — same
    // request, same host store, so the snapshot cannot go stale mid-call.
    const config = Bakery.config
    const intercepted = await config.onRequest(req!)
    if (intercepted) {
      // `|| undefined` used to sit here, and `injectIfHtml` returns null for
      // anything that is not HTML — so a plain-text 403 from `onRequest`
      // vanished and the request carried on. Inject when it is HTML, keep the
      // original otherwise, exactly as the middleware chain below does.
      return (await injectIfHtml(intercepted)) || intercepted
    }

    let data: any

    for (const middleware of config.middleware) {
      try {
        const result = await middleware(req, Bakery.server!)
        if (result instanceof Response) {
          data = result
          break
        }
      } catch (error) {
        // Fail closed: a middleware that throws is often an auth check, and
        // treating it as "no response" would let the request through.
        handlerLog.MIDDLEWARE_ERR({ error: errorMsg(error) })
        return response.error('Internal Server Error', 500)
      }
    }

    const injectedRes = await injectIfHtml(data)
    return injectedRes || data
  }
}
