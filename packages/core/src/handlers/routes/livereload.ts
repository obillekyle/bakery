import { connectedLoggers, log, serveLog } from '../../logger'
import { WebSocketHandler } from '../core/$websocket'

export class LiveReloadHandler extends WebSocketHandler {
  static connectedLoggers = connectedLoggers

  static init() {}

  static canHandle(path: string) {
    if (!import.meta.env.DEV || !import.meta.env.DEV_WORKER) return false
    return path === '/_livereload'
  }

  static upgrade() {}

  static open(ws: ServerWebSocket) {
    if (!import.meta.env.DEV) return
    ws.subscribe('livereload')
  }

  static message(ws: ServerWebSocket, message: any) {
    if (!import.meta.env.DEV) return
    try {
      const parsed = JSON.parse(String(message))
      const { type: msgType, level, payload } = parsed
      switch (msgType) {
        case 'subscribe_logger':
          LiveReloadHandler.connectedLoggers.add(ws)
          break

        case 'force_reload':
          serveLog.MANUAL_RELOAD()
          ws.publish('livereload', 'force_reload')

          break
        case 'client_log': {
          const ipAddr = ws.remoteAddress
          const clientLogMsg = JSON.stringify({ ...parsed, by: ipAddr })
          LiveReloadHandler.connectedLoggers.forEach(
            loggerWs => void loggerWs.send(clientLogMsg),
          )
          log({ by: ipAddr, msg: payload, level })
          break
        }
      }
    } catch (err: any) {
      serveLog.WEBSOCKET_ERR({ ip: ws.remoteAddress, error: String(err) })
    }
  }

  static close(ws: ServerWebSocket) {
    LiveReloadHandler.connectedLoggers.delete(ws)
  }
}
