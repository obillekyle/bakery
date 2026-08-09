import { WebSocketHandler } from '@bakery-framework/core/handlers'
import type { ServerWebSocket } from 'bun'
import { computeStats, isAnalyticsAuthorized } from './stats'

export const connectedAnalyticsClients = new Set<any>()

export class AnalyticsWSHandler extends WebSocketHandler {
  // The upgrade is dispatched before any plugin hook runs, so the auth check
  // has to live here. Without it this socket served the same payload the HTTP
  // stats endpoint guards — and pushed it live every second.
  static canHandle(path: string, req?: Request): boolean {
    if (path !== '/_analytics_ws') return false
    return req ? isAnalyticsAuthorized(req) : false
  }

  static open(ws: ServerWebSocket<any>, _data: any) {
    connectedAnalyticsClients.add(ws)
  }

  static upgrade() {
    return {
      timescale: '1m',
      excludeHistory: true,
      pagesFilter: '1d',
    }
  }

  static async message(ws: ServerWebSocket<any>, message: any, data: any) {
    try {
      const msg = JSON.parse(String(message))
      if (msg.type === 'subscribe') {
        data.timescale = msg.timescale || '1m'
        data.excludeHistory = !!msg.excludeHistory
        data.pagesFilter = msg.pagesFilter || '1d'

        const stats = computeStats(
          data.timescale,
          data.excludeHistory,
          data.pagesFilter,
        )

        ws.send(
          JSON.stringify({
            status: 200,
            excludeHistory: data.excludeHistory,
            data: stats,
          }),
        )
      }
    } catch {
      // The frame came from a client. Malformed JSON, or a subscribe naming a
      // timescale that computes to nothing, must not throw out of the socket
      // handler and take the connection down with it.
    }
  }

  static close(ws: any) {
    connectedAnalyticsClients.delete(ws)
  }
}
