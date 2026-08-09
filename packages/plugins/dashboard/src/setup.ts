import { bundleModule } from '@bakery/core/compiler'
import { Bakery } from '@bakery/core/core/bakery'
import { isDevWorker } from '@bakery/core/core/init'
import { Handler, mountRoutes } from '@bakery/core/handlers'
// LiveReloadHandler owns this registry — it adds and removes sockets from it.
import {
  connectedLoggers,
  errorMsg,
  pluginLog,
  setLogCallback,
} from '@bakery/core/logger'
import { type PluginRouteTable, routeTable } from '@bakery/core/plugins'
import type { JsonResponseData } from '@bakery/core/utils/common'
import { Try } from '@bakery/core/utils/common'
import { checkCsrf, injectIfHtml, response } from '@bakery/core/utils/http'
import {
  type AuthorizeFn,
  defaultAuthorize,
  isAuthorized,
  resolveAuthorize,
} from './authorize'
import {
  handleExecuteAction,
  handleQuery,
  handleSchema,
  handleTableData,
} from './endpoints/database'
import {
  handleDeleteSession,
  handleGetSessions,
  handleUpdateSession,
} from './endpoints/sessions'
import { pluginPath } from './paths'
import renderDashboardShell from './shell'

export { connectedLoggers }

let cachedDashboardJsPath: string | null = null

/**
 * `/_dashboard` and `/api/_dashboard` are namespace *roots*, not prefixes.
 *
 * A bare `startsWith` also matches `/api/_dashboard-anything`, and this handler
 * outranks every content handler at priority 120 — so the prefix form silently
 * claimed, and then 404'd, any application route whose path merely began with
 * those characters. Match the root itself or a segment below it, nothing else.
 */
function inNamespace(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

function isDashboardPath(path: string): boolean {
  return (
    inNamespace(path, '/_dashboard') || inNamespace(path, '/api/_dashboard')
  )
}

export class DashboardHandler extends Handler {
  static canHandle(path: string) {
    // Deliberately narrow. This handler outranks every content handler, so
    // anything it claims can never reach the route mount below — assets must
    // fall through.
    if (inNamespace(path, '/api/_dashboard')) return true
    return path === '/_dashboard' || path === '/_dashboard/dashboard.js'
  }

  static resolveRoute(path: string): Handler.Route.Info | null {
    if (isDashboardPath(path)) {
      return new Handler.Route.Info(pluginPath('setup.tsx'), path)
    }
    return null
  }

  static async handle(
    _path: string,
    req: Request,
  ): Promise<DashboardResponse | undefined> {
    const res = await handleDashboardRequest(req)
    return res || undefined
  }
}

let authorize: AuthorizeFn = defaultAuthorize

/**
 * Test seam for the module-level predicate, symmetric with `__setTestDb` in
 * `@bakery/orm` and `__setTestConfig` in core.
 *
 * `setupDashboard` is the only other way to set it, and it also mounts routes,
 * registers the handler at priority 120 and installs a global log callback —
 * three process-global mutations, none of them restorable. A test that only
 * needs the request pipeline sets the predicate directly and puts it back in
 * `afterAll`. Always pair with `__resetTestAuthorize()`.
 */
export function __setTestAuthorize(fn: AuthorizeFn): void {
  authorize = fn
}

export function __resetTestAuthorize(): void {
  authorize = defaultAuthorize
}

export function setupDashboard(options: { authorize?: AuthorizeFn } = {}) {
  authorize = resolveAuthorize(options.authorize)

  setLogCallback(entry => {
    // Broadcast to the registry LiveReloadHandler actually populates. This used
    // to target a Set nothing ever added to, so the Logs tab was always empty
    // and every log line paid for a JSON.stringify that went nowhere.
    if (!connectedLoggers.size) return

    const message = JSON.stringify({
      type: 'server_log',
      level: entry.level,
      by: entry.by,
      payload: entry.msg,
      timestamp: Date.now(),
    })
    connectedLoggers.forEach(loggerWs => {
      Try(() => loggerWs.send(message))
    })
  })

  // The stylesheet is served by the normal static pipeline from this
  // plugin's own directory — no bespoke asset route, no hand-rolled caching.
  mountRoutes('/_dashboard', pluginPath('../public'))

  Bakery.handlers.fetch.set(DashboardHandler, 120)
}

async function handleDashboardView() {
  const htmlContent = await renderDashboardShell()
  const injected = await injectIfHtml(htmlContent)

  return injected ? injected : response.html(htmlContent)
}

async function handleJsAsset() {
  if (cachedDashboardJsPath && !isDevWorker) {
    const cachedFile = Bun.file(cachedDashboardJsPath)
    if (cachedFile.size > 0) return response.type(cachedFile, 'text/javascript')
  }

  const bundleResult = await bundleModule(pluginPath('client/dashboard.ts'))

  if (!bundleResult.success || !bundleResult.content) {
    pluginLog.DASHBOARD_BUNDLE_ERR({
      error: errorMsg(bundleResult.errors?.join('\n')),
    })
    return response.error(
      `Failed to bundle dashboard.js: ${bundleResult.errors?.join('\n')}`,
      500,
    )
  }

  if (!isDevWorker) {
    const tmpPath = `${Bakery.cacheDir}/_dashboard.js`
    await Bun.write(tmpPath, bundleResult.content)
    const writtenFile = Bun.file(tmpPath)
    if (writtenFile.size > 0) {
      cachedDashboardJsPath = tmpPath
      return writtenFile
    }
  }

  return response.type(bundleResult.content, 'text/javascript')
}

async function checkAuthMiddleware(req: Request, path: string) {
  // Styling and script for the console are not secrets, and letting them
  // through keeps an unauthorised response from rendering unstyled.
  if (/\.(css|js)$/.test(path)) return null

  if (await isAuthorized(authorize, req)) return null

  return path.startsWith('/api/')
    ? response.error('Unauthorized', 401)
    : response.error('Not Found', 404)
}

/**
 * `checkCsrf` has exactly one other call site — inside `ApiHandler`, at
 * priority 70. This handler sits at 120 and claims the whole `/api/_dashboard`
 * namespace, so `ApiHandler.handle` never ran for these paths and the check
 * never happened: a cross-origin `<form method=post>` arrived with the
 * operator's cookies attached and reached the database.
 *
 * Necessary but **not sufficient on its own**. `SAFE_METHODS` exempts GET, and
 * `processBody` reads a GET's query string as the body, so a plain
 * `<img src="/api/_dashboard/execute-action?action=truncate&tableName=…">`
 * sails past this guard. The mutating keys in the table below are
 * method-qualified for exactly that reason; neither half closes the hole alone.
 */
function checkCsrfMiddleware(req: Request, url: URL): DashboardResponse | null {
  const reason = checkCsrf(req, url)
  if (!reason) return null

  return url.pathname.startsWith('/api/')
    ? response.json.error(403, reason)
    : response.error(reason, 403)
}

/**
 * Authenticated routes only — the logout/login cases below run before the auth
 * check and are deliberately kept out of this table.
 *
 * Every mutating endpoint is method-qualified. A bare key matches **any**
 * method, which made each of these reachable by GET — and a GET is a safe
 * method as far as `checkCsrf` is concerned, so the CSRF guard above cannot
 * see it. `POST /api/_analytics/reset` is the same shape.
 *
 * `satisfies` rather than an annotation: an annotation erases the literal type,
 * which would collapse every endpoint's return type back into the wide
 * `ValidResponses` (and its `object` member) before `routeTable` ever sees it.
 */
const dashboardRoutes = {
  '/_dashboard': () => handleDashboardView(),
  '/_dashboard/dashboard.js': () => handleJsAsset(),
  '/api/_dashboard/sessions': (_req, url) => handleGetSessions(url),
  'POST /api/_dashboard/sessions/delete': req => handleDeleteSession(req),
  'POST /api/_dashboard/sessions/update': req => handleUpdateSession(req),
  '/api/_dashboard/schema': () => handleSchema(),
  '/api/_dashboard/table-data': (_req, url) => handleTableData(url),
  'POST /api/_dashboard/query': req => handleQuery(req),
  'POST /api/_dashboard/execute-action': req => handleExecuteAction(req),
} satisfies PluginRouteTable

const dispatchDashboardRoute = routeTable(dashboardRoutes)

/**
 * Three genuinely different shapes, so a union rather than a single type: the
 * shell is a `Response`, `dashboard.js` is served straight off disk as a
 * `Bun.BunFile` once it has been bundled and cached, and every `/api/` endpoint
 * answers with the JSON envelope. `processResponse` in `router.ts` serialises
 * all three — `Response` passes through, a `Blob` goes to `ETag.sendFile`, and
 * a `JsonResponseData` is stamped with the elapsed time and JSON-encoded.
 */
export type DashboardResponse =
  | Response
  | Bun.BunFile
  | JsonResponseData<unknown>

export async function handleDashboardRequest(
  req: Request,
): Promise<DashboardResponse | null> {
  const url = new URL(req.url)
  const path = url.pathname

  if (!isDashboardPath(path)) return null

  // Auth first, so a cross-origin probe from an unauthenticated peer gets the
  // same 404/401 as any other unauthenticated request rather than a 403 that
  // confirms the console is mounted here.
  const authBlock = await checkAuthMiddleware(req, path)
  if (authBlock) return authBlock

  const csrfBlock = checkCsrfMiddleware(req, url)
  if (csrfBlock) return csrfBlock

  return dispatchDashboardRoute(req, url)
}
