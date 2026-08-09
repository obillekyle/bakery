import { Bakery, hostStore } from './core/bakery'
import { matchBlockedCached } from './core/context'
import { PluginHooks } from './core/plugins'
import { DefaultErrorHandler } from './handlers/assets/static'
import type { Handler } from './handlers/core/$base'
import { ErrorHandler } from './handlers/core/$error'
import { WebSocketHandler } from './handlers/core/$websocket'
import { errorMsg, getElapsed, log, serveLog } from './logger'
import { Session } from './session'
import type { MixedPromise } from './types'
import { JsonResponseData } from './utils'
import { is, Try } from './utils/common'
import { fs } from './utils/fs'
import {
  checkWebSocketOrigin,
  ETag,
  injectIfHtml,
  response,
  withStatus,
} from './utils/http'

/**
 * Resolve a WebSocket upgrade, refusing cross-origin handshakes first.
 *
 * The origin check lives here rather than in each `canHandle` on purpose:
 * every socket a plugin or an app registers inherits it, instead of every
 * author having to remember. `/_analytics_ws` was the only handler that got it
 * right on its own, and it did so by authenticating — `/_livereload` had
 * nothing, and `WebSocketHandler.canHandle` returns `true` by default, so the
 * base class was handing out sockets to anyone who asked.
 *
 * Returning `false` (rather than a 403) keeps the published signature — the
 * caller below turns a refusal into `400 WebSocket Upgrade Failed`, which is
 * also what an unclaimed path gets. The reason reaches the log; the client is
 * told nothing it did not already know.
 */
export async function upgradeWebsocket(
  req: Request,
  path: string,
): Promise<boolean | undefined> {
  const url: URL = (req as any).__parsedUrl || new URL(req.url)
  const denied = checkWebSocketOrigin(req, url)
  if (denied) {
    serveLog.WEBSOCKET_ERR({
      ip: Bakery.server?.requestIP(req)?.address || 'Unknown',
      error: denied,
    })
    return false
  }

  try {
    const upgrade = await Bakery.handlers.websocket.handle(path, req)
    return Boolean(upgrade)
  } catch (err: any) {
    serveLog.UNHANDLED_ERR({
      error: `Error checking WebSocketHandler: ${errorMsg(err)}`,
    })
  }
  return false
}

/**
 * Whether the deny-list applies to whatever this handler is about to answer
 * with. `Bakery.config.blocked` exists to stop files on disk being served, so
 * handlers that read the request path as a route *name* opt out by declaring
 * `servesFiles = false` — `ApiHandler`, `ProxyHandler`, `MiddlewareHandler`.
 *
 * Deny by default, and the direction matters. Naming only the obvious file
 * servers — Static, Public, NM — would have left `/schema.ts` and
 * `/server.config.ts` reachable through `TSHandler`, which compiles a source
 * file and serves the result. Anything that does not opt out, including a
 * plugin's handler, keeps the check.
 *
 * The flag lives on `Handler` (see its doc comment) rather than in a list
 * here so that `DynamicHandler.resolveRoute` can gate the *resolved-file*
 * check on the same answer. Two lists would have drifted, and the resolved
 * check is what closes the extension-substitution hole this one cannot see.
 */
function servesFiles(handler: any): boolean {
  return handler?.servesFiles !== false
}

export function handleRequest(
  req: Request,
): Handler.Response | MixedPromise<symbol>
export async function handleRequest(req: Request) {
  // worker.ts parses and attaches this before calling in; the fallback keeps
  // direct callers (tests, embedders) working.
  const url: URL = (req as any).__parsedUrl || new URL(req.url)
  ;(req as any).__parsedUrl = url
  const path = url.pathname

  // One read of the config getter, not three: `Bakery.serveRoot` walks
  // `hostStore.getStore()?.config ?? getConfig()` on every access, and the
  // blocked-glob check below used to pay the same walk again. And no
  // `fs.resolve` around the target — `isForbidden` normalises both arguments
  // itself, so that was a second full path resolution of the same string on
  // every request.
  const config = Bakery.config
  const serveRoot = config.root
  if (fs.isForbidden(serveRoot + path, serveRoot)) {
    return new Response('Forbidden', { status: 403 })
  }

  if (req.headers.get('Upgrade') === 'websocket') {
    const wsHandled = await upgradeWebsocket(req, path)
    return wsHandled
      ? WebSocketHandler.WS_UPGRADE
      : response.error('WebSocket Upgrade Failed', 400)
  }

  await PluginHooks.onRoute(req)

  const pluginResponse = await PluginHooks.onRequest(req)
  if (pluginResponse) return pluginResponse

  // Resolved rather than dispatched, because the blocked globs are a question
  // about *which* handler is about to answer. Testing them against the raw
  // path up front made `/api/manifest.json` a 403 before routing had a say,
  // and no config could opt out of it. `resolve` is what `HandlerMap.handle`
  // calls anyway, so this costs nothing extra.
  const handler = await Bakery.handlers.fetch.resolve(path, req)
  if (!handler) return new Response('Not Found', { status: 404 })

  // `matchBlockedCached` memoises the verdict on the request store, so the
  // re-check `StaticHandler.handle` keeps for its direct callers costs a map
  // hit instead of a second pair of glob matches.
  if (servesFiles(handler) && matchBlockedCached(config.blocked, path)) {
    return new Response('Forbidden', { status: 403 })
  }

  return handler.handle(path, req)
}

const isWSHandler = (handler: any) =>
  handler &&
  (handler.prototype instanceof WebSocketHandler ||
    handler === WebSocketHandler)

function prepareWSData(ws: any) {
  ws.data ||= {}
  const mainData = ws.data
  if (isWSHandler(mainData.this)) {
    mainData.data ||= {}
    return { handler: mainData.this, data: mainData.data }
  }
  return null
}

/**
 * The resolved config is handed to `fn` rather than re-read inside it:
 * `Bakery.config` inside the callback would land on exactly the store entry
 * installed here, so reading it again paid a second
 * `AsyncLocalStorage.getStore` per WebSocket event for the same object.
 */
function runInHostContext<T>(
  ws: any,
  fn: (config: Readonly<ProcessedAppConfig>) => Promise<T> | T,
): Promise<T> | T {
  const mainData = ws?.data || {}
  const config = mainData.config || Bakery.config
  const hostname = mainData.hostname || ''
  return hostStore.run({ config, hostname }, () => fn(config))
}

export const serveWebSocket: Bun.WebSocketHandler<any> = {
  async message(ws: any, message) {
    return runInHostContext(ws, async config => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.message(ws, message, h.data)
        config.websocket.message(ws, message)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket message error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async open(ws: any) {
    return runInHostContext(ws, async config => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.open(ws, h.data)
        await config.websocket.open?.(ws)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket open error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async close(ws: any, code: number, reason: string) {
    return runInHostContext(ws, async config => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.close(ws, code, reason, h.data)
        await config.websocket.close?.(ws, code, reason)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket close error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async drain(ws: any) {
    return runInHostContext(ws, async config => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.drain(ws, h.data)
        await config.websocket.drain?.(ws)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket drain error: ${errorMsg(err)}`,
        })
      }
    })
  },
}

/**
 * Make an error page answer with the error's status.
 *
 * The HTML and TSX error handlers end in `injectIfHtml`, which builds its
 * Response without one — so an app with `src/error-404.html` served its 404
 * page as `200 OK` and every crawler, cache and monitor believed it. Applied
 * here rather than inside `injectIfHtml` on purpose: the only status signal
 * available down there is `params`, which for a GET is the query string, and
 * `?errorCode=500` is not something a client gets to decide.
 *
 * A `JsonResponseData` (the `/api/` arm) carries its own `.status` that
 * `processResponse` reads, and a BunFile has no status at all — both pass
 * through untouched.
 */
function applyErrorStatus(
  res: Awaited<Handler.Response>,
  code: number,
): Awaited<Handler.Response> {
  if (!(res instanceof Response)) return res
  if (!Number.isInteger(code) || code < 400 || code > 599) return res
  return withStatus(res, code)
}

export function handleRequestError(
  path: string,
  req?: Request,
  error?: any,
): Handler.Response
export async function handleRequestError(
  path: string,
  req?: Request,
  error?: any,
) {
  req ||= new Request('http://localhost/__internal__')
  error = ErrorHandler.extractErrorData(error)

  const pluginRes = await PluginHooks.onError(error, req)
  if (pluginRes) return pluginRes

  const bakeryError = Object.assign({}, error, {
    errorBody: `${error.errorBody} at ${path}`,
  })

  // Wrapped for the same reason the registry call below it is: this is app
  // code. An `onError` that throws used to escape `Try.return`'s fallback in
  // the caller — a fallback that itself rejects is not a fallback — so the one
  // hook whose job is to handle failure took the app's error page down with
  // it and the client got Bun's raw 500 instead.
  const [onErrorFailed, configError] = await Try.catch(() =>
    Bakery.config.onError(bakeryError),
  )

  if (onErrorFailed) {
    serveLog.UNHANDLED_ERR({
      error: `Error in config.onError: ${errorMsg(onErrorFailed)}`,
    })
  }

  if (configError instanceof Response) {
    const injectedRes = await injectIfHtml(configError)
    return injectedRes || configError
  }

  try {
    const errRes = await Bakery.handlers.error.handle(path, req, error)
    if (errRes) return applyErrorStatus(errRes, error.errorCode)
  } catch (err: any) {
    serveLog.UNHANDLED_ERR({
      error: `Error in ErrorHandler: ${errorMsg(err)}`,
    })
  }

  return DefaultErrorHandler.handle(path, req, error)
}

export async function processResponse(
  data: Handler.Response | MixedPromise<symbol>,
  req: Request,
): Promise<Response | undefined> {
  data = await data
  let status = 200
  let type = 'text/plain; charset=utf-8'
  if (data === WebSocketHandler.WS_UPGRADE) return
  if (data === null || data === undefined)
    return new Response(null, { status: 204 })

  const resp = await (async function getResponse() {
    if (data instanceof Response) {
      return (await injectIfHtml(data)) || data
    }

    if (data instanceof Blob) {
      return ETag.sendFile(data as Bun.BunFile, req)
    }

    if (typeof data === 'string') {
      const injected = await injectIfHtml(data)
      return injected || response.text(data)
    }

    if (data instanceof JsonResponseData) {
      data.time = getElapsed(req.startNs)
      status = data.status
      data = data.toJson()
      type = 'application/json'
    }

    if (is.object(data)) {
      data = JSON.stringify(data)
      type = 'application/json'
    }

    return ETag.sendText(String(data), req, type, status)
  })()

  const sess = Session.getCookie(req)

  // append, not set: a handler may already have issued its own Set-Cookie
  // (e.g. an auth cookie from a login route) that must not be overwritten.
  sess && resp.headers.append('Set-Cookie', sess)
  const final = ETag.sendResponse(req, resp)
  if (!(final instanceof Response)) {
    log({
      by: 'final-response',
      level: 'error',
      msg: 'ETag failed to generate a valid response',
    })
  }

  return final
}
