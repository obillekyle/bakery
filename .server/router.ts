import { Bakery, hostStore } from '@server/core/bakery'
import { Session } from './session'
import { DefaultErrorHandler } from '@server/handlers/assets/static'
import type { Handler } from '@server/handlers/core/$base'
import { ErrorHandler } from '@server/handlers/core/$error'
import { WebSocketHandler } from '@server/handlers/core/$websocket'
import { log } from '@server/logger'
import { JsonResponseData } from '@server/utils'
import { is } from '@server/utils/common'
import { fs } from '@server/utils/fs'
import { ETag, injectIfHtml, response } from '@server/utils/http'
import { errorMsg, getElapsed, serveLog } from './logger'
import { PluginHooks } from './core/plugins'

export async function upgradeWebsocket(
  req: Request,
  path: string,
): Promise<boolean | undefined> {
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

export function handleRequest(
  req: Request,
): Handler.Response | MixedPromise<symbol>
export async function handleRequest(req: Request) {
  const url = new URL(req.url)
  ;(req as any).__parsedUrl = url
  const path = url.pathname

  if (Bakery.config.blocked?.match(path)) {
    return new Response('Forbidden', { status: 403 })
  }

  const targetPath = fs.resolve(Bakery.serveRoot + path)
  if (fs.isForbidden(targetPath, Bakery.serveRoot)) {
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

  const fetchH = Bakery.handlers.fetch.handle(path, req)
  if (fetchH) return fetchH

  return new Response('Not Found', { status: 404 })
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

function runInHostContext<T>(
  ws: any,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const mainData = ws?.data || {}
  const config = mainData.config || Bakery.config
  const hostname = mainData.hostname || ''
  return hostStore.run({ config, hostname }, fn)
}

export const serveWebSocket: Bun.WebSocketHandler<any> = {
  async message(ws: any, message) {
    return runInHostContext(ws, async () => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.message(ws, message, h.data)
        Bakery.config.websocket.message(ws, message)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket message error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async open(ws: any) {
    return runInHostContext(ws, async () => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.open(ws, h.data)
        await Bakery.config.websocket.open?.(ws)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket open error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async close(ws: any, code: number, reason: string) {
    return runInHostContext(ws, async () => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.close(ws, code, reason, h.data)
        await Bakery.config.websocket.close?.(ws, code, reason)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket close error: ${errorMsg(err)}`,
        })
      }
    })
  },
  async drain(ws: any) {
    return runInHostContext(ws, async () => {
      try {
        const h = prepareWSData(ws)
        if (h) return await h.handler.drain(ws, h.data)
        await Bakery.config.websocket.drain?.(ws)
      } catch (err: any) {
        serveLog.UNHANDLED_ERR({
          error: `WebSocket drain error: ${errorMsg(err)}`,
        })
      }
    })
  },
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

  const configError = await Bakery.config.onError(bakeryError)
  if (configError instanceof Response) {
    const injectedRes = await injectIfHtml(configError)
    return injectedRes || configError
  }

  try {
    const errRes = await Bakery.handlers.error.handle(path, req, error)
    if (errRes) return errRes
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
      data = data.toJson()
      type = 'application/json'
    }

    if (is.object(data)) {
      data = JSON.stringify(data)
      type = 'application/json'
    }

    return ETag.sendText(String(data), req, type)
  })()

  const sess = Session.getCookie(req)

  sess && resp.headers.set('Set-Cookie', sess)
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
