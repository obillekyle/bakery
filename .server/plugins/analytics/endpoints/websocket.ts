import { WebSocketHandler } from '@server/handlers/core/$websocket'
import type { ServerWebSocket } from 'bun'
import { computeStats } from './stats'

export const connectedAnalyticsClients = new Set<any>()

export class AnalyticsWSHandler extends WebSocketHandler {
  static canHandle(path: string): boolean {
    return path === '/_analytics_ws'
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
    } catch {}
  }

  static close(ws: any) {
    connectedAnalyticsClients.delete(ws)
  }
}
