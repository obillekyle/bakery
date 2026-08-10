import { Bakery } from '../../core/bakery'
import { errorMsg, handlerLog } from '../../logger/serve-log'
import { JsonResponseData } from '../../utils/common/json'
import { injectIfHtml, response } from '../../utils/http'
import { Handler } from './$base'

/**
 * What a middleware may return to stop the chain.
 *
 * A `Response` and a `response.json.*` envelope, and deliberately nothing
 * else. `JsonResponseData` is the framework's one-envelope idiom (convention
 * 7) and `processResponse` already renders it with its own `status`, so an
 * `ApiHandler` route returning `response.json.error(401, …)` answered 401
 * while the identical line in a middleware did not — the value was not a
 * `Response`, so the chain ignored it and the request carried on.
 *
 * Widening further, to "anything truthy", is the tempting version and is
 * wrong: a middleware that returns a stray string or object would then halt
 * the request by accident, and returning a value is how middleware signals
 * *nothing* in plenty of code (`arr.map`, an assignment expression, an
 * implicit arrow return). Two named shapes, both of which mean "I am the
 * response".
 */
type MiddlewareResult = Response | JsonResponseData

function isMiddlewareResult(value: unknown): value is MiddlewareResult {
  return value instanceof Response || value instanceof JsonResponseData
}

/**
 * Per-request slot for the response produced during `canHandle`, so `handle`
 * can return it without re-running the chain. This was previously a static
 * field, which meant two concurrent requests could swap responses — including
 * each other's `Set-Cookie` headers — at any `await` boundary.
 */
const pending = new WeakMap<Request, MiddlewareResult>()

export class MiddlewareHandler extends Handler {
  /** Answers from app code, not from disk. See `Handler.servesFiles`. */
  static servesFiles = false

  /**
   * `canHandle` here means "was this request denied", which is a fact about
   * the request and not about the path. Without this the route cache would
   * serve the page handler that the first *allowed* request resolved to,
   * and every later request to that path would skip middleware entirely.
   */
  static override alwaysResolve = true

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

    let data: MiddlewareResult | undefined

    for (const middleware of config.middleware) {
      try {
        const result = await middleware(req, Bakery.server!)
        if (isMiddlewareResult(result)) {
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

    // An envelope is JSON by construction, so it skips injection rather than
    // paying `DOMTools.isHTML` to be told so. `processResponse` reads its
    // `status` and serialises it.
    if (data instanceof JsonResponseData) return data

    const injectedRes = await injectIfHtml(data!)
    return injectedRes || data
  }
}
