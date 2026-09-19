import { WebSocketHandler } from '@bakery-framework/core/handlers'
import { connectedLoggers } from '@bakery-framework/core/logger'
import { isAnalyticsAuthorized } from '@bakery-framework/plugin-analytics/stats'
import type { ServerWebSocket } from 'bun'

/**
 * The console's log stream.
 *
 * **The Logs panel was dead in production**, and only in production. Its client
 * connected to `/_livereload`, which `LiveReloadHandler` serves — and that
 * handler is registered only under `DEV` and refuses in `canHandle` besides.
 * So a production server answered 400 on the upgrade, nothing ever joined
 * `connectedLoggers`, and the panel sat on "Connecting to server log
 * stream..." for the life of the process. Measured against `bun run serve`
 * before this existed: `/_livereload` → 400, console → 200.
 *
 * Same shape as the bundle ETag bug and the timescale import before it: a dev
 * server takes a different branch, so the thing works on the machine where it
 * is written and nowhere else.
 *
 * **Not fixed by registering `LiveReloadHandler` in production.** That socket
 * is the *watcher's*: it publishes `force_reload` to every subscriber and
 * echoes `client_log` frames between browsers. Shipping it to production would
 * be adding a surface, not repairing one. The console owns its own panel, so
 * it owns its own socket, which is the same split analytics already has with
 * `/_analytics_ws`.
 *
 * Membership is the only thing this does. Core owns the registry
 * (`logger/clients.ts`) and the dashboard's `setLogCallback` does the
 * broadcasting; in development `LiveReloadHandler` adds app pages to the same
 * Set when they forward their console, which is why those lines show up here
 * too.
 */
export class DashboardLogsHandler extends WebSocketHandler {
  static override readonly namespace = '/_dashboard'

  /**
   * **The door is checked here because there is nowhere later.**
   *
   * `router.ts` attempts the upgrade before `onRoute`, before `onRequest` and
   * before any fetch handler resolves, so a plugin hook cannot gate a socket.
   * `AnalyticsWSHandler` carries the same note for the same reason.
   *
   * It is the console's own door: `isAnalyticsAuthorized` is what guards
   * `/_dashboard` itself, so a stream of every server log line is admitted by
   * exactly what admits the page that renders it. Anything weaker would hand
   * out log lines to someone who cannot open the console.
   *
   * Async because `authorize` may be a predicate the application supplies; the
   * registry awaits a promise-returning `canHandle`.
   *
   * The path sits inside `/_dashboard`, which `DashboardHandler` claims for
   * *fetch* at priority 120. That is not a collision: the upgrade is dispatched
   * from a separate registry and runs first, so the fetch handler never sees
   * this request.
   */
  static override async canHandle(
    path: string,
    req?: Request,
  ): Promise<boolean> {
    if (path !== '/_dashboard/logs') return false
    return req ? await isAnalyticsAuthorized(req) : false
  }

  static override open(ws: ServerWebSocket<any>) {
    connectedLoggers.add(ws)
  }

  static override close(ws: ServerWebSocket<any>) {
    connectedLoggers.delete(ws)
  }
}
