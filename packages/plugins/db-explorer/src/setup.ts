import { bundleModule } from '@bakery-framework/core/compiler'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { Handler } from '@bakery-framework/core/handlers'
import { errorMsg } from '@bakery-framework/core/logger'
import type { PluginRouteTable } from '@bakery-framework/core/plugins'
import { routeTable } from '@bakery-framework/core/plugins'
import { fs } from '@bakery-framework/core/utils'
import { response } from '@bakery-framework/core/utils/http'
import {
  type AuthorizeFn,
  credentialMatches,
  defaultAuthorize,
  isAuthorized,
  resolveAuthorize,
} from './authorize'
import { handleSchema, handleTableData } from './endpoints'

/**
 * Where this plugin's own files live — each package that ships files anchors
 * to its own location, never to core's (see the dashboard's `paths.ts` for
 * the 404s that lesson cost).
 */
const pluginRoot: string = fs.resolve(import.meta.dir)

let authorize: AuthorizeFn = defaultAuthorize
let credential: string | undefined

/**
 * Test seam, same shape as the dashboard's: `setupExplorer` mutates process
 * globals that cannot be restored, so tests that only need the request
 * pipeline set the predicate directly. Always pair with the reset.
 */
export function __setTestAuthorize(fn: AuthorizeFn): void {
  authorize = fn
}

export function __resetTestAuthorize(): void {
  authorize = defaultAuthorize
  credential = undefined
}

/** Test seam for the credential path; reset with __resetTestAuthorize. */
export function __setTestCredential(value: string | undefined): void {
  credential = value
}

const SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Database explorer</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e6e8ee; }
  #app { display: flex; min-height: 100vh; }
  .side { width: 220px; padding: 1rem; border-right: 1px solid #262b36; flex-shrink: 0; }
  .brand { font-size: 1rem; margin: 0; }
  .note { color: #9aa3b2; font-size: 0.8rem; }
  .error { color: #ff8ba0; padding: 1rem; }
  .table-btn { display: block; width: 100%; text-align: left; background: none; border: 0; color: #cfd6e4; padding: 0.35rem 0.5rem; border-radius: 6px; cursor: pointer; font: inherit; }
  .table-btn:hover { background: #1a1f2b; }
  .table-btn.active { background: #16233d; color: #cfe0ff; }
  .main { flex: 1; padding: 1rem 1.5rem; min-width: 0; }
  .table-head { display: flex; align-items: baseline; gap: 1rem; }
  .table-head h2 { margin: 0.2rem 0 0.8rem; font-family: ui-monospace, monospace; font-size: 1rem; }
  .scroll { overflow-x: auto; border: 1px solid #262b36; border-radius: 8px; }
  .grid { border-collapse: collapse; width: 100%; font-size: 0.82rem; }
  .grid th { text-align: left; padding: 0.45rem 0.7rem; background: #151922; cursor: pointer; white-space: nowrap; position: sticky; top: 0; }
  .grid td { padding: 0.35rem 0.7rem; border-top: 1px solid #1e2430; font-family: ui-monospace, monospace; white-space: nowrap; max-width: 26rem; overflow: hidden; text-overflow: ellipsis; }
  .grid td.null { color: #5b6472; font-style: italic; }
  .pager { margin-top: 0.8rem; display: flex; gap: 0.5rem; }
  .pager button { font: inherit; padding: 0.3rem 0.8rem; border-radius: 6px; border: 1px solid #2f6feb; background: #16233d; color: #cfe0ff; cursor: pointer; }
  .pager button:disabled { opacity: 0.4; cursor: default; }
</style>
</head>
<body>
<div id="app"><p class="note" style="padding:1rem">loading…</p></div>
<script type="module" src="/_db/app.js"></script>
</body>
</html>`

let cachedClientJs: string | null = null

async function handleClientJs() {
  // PROD caches the bundle in memory; dev recompiles so edits show up.
  if (cachedClientJs && import.meta.env.PROD) {
    return response.type(cachedClientJs, 'text/javascript; charset=utf-8')
  }

  const built = await bundleModule(
    fs.resolve(pluginRoot, 'client.ts') as fs.AbsolutePath,
  )
  if (!built.success || !built.content) {
    return response.error(
      `Failed to bundle explorer client: ${errorMsg(built.errors?.join('\n'))}`,
      500,
    )
  }

  cachedClientJs = built.content
  return response.type(built.content, 'text/javascript; charset=utf-8')
}

/**
 * Read-only by construction: the two data endpoints call only `getSchema`
 * and `getData`. No raw SQL, no row mutations, no DDL — the write paths do
 * not exist, which is a stronger property than any gate over them. The keys
 * are method-unqualified because a bare key matches any method and every
 * handler here is a read; there is nothing a smuggled POST could mutate,
 * which is also why this table carries no CSRF middleware where the
 * dashboard's must.
 */
const explorerRoutes = {
  '/_db': () => response.html(SHELL),
  '/_db/app.js': () => handleClientJs(),
  '/api/_db/schema': () => handleSchema(),
  '/api/_db/table-data': (_req, url) => handleTableData(url),
} satisfies PluginRouteTable

const dispatchExplorerRoute = routeTable(explorerRoutes)

export class DbExplorerHandler extends Handler {
  static canHandle(path: string) {
    return (
      path === '/_db' ||
      path.startsWith('/_db/') ||
      path === '/api/_db' ||
      path.startsWith('/api/_db/')
    )
  }

  static async handle(path: string, req: Request) {
    // Styling and script are not secrets, and letting them through keeps an
    // unauthorised response from rendering unstyled — same split as the
    // dashboard. Everything else fails closed. Either door admits: the
    // shared credential (constant-time, off when unset) or the predicate.
    const admitted =
      credentialMatches(credential, req) || (await isAuthorized(authorize, req))
    if (!/\.(css|js)$/.test(path) && !admitted) {
      return path.startsWith('/api/')
        ? response.error('Unauthorized', 401)
        : response.error('Not Found', 404)
    }

    // Dispatch keys on `url.pathname` from the request itself — the `path`
    // argument only steers the auth split above.
    const result = await dispatchExplorerRoute(req)
    return result ?? response.error('Not Found', 404)
  }
}

export function setupExplorer(
  options: { authorize?: AuthorizeFn; credential?: string } = {},
) {
  authorize = resolveAuthorize(options.authorize)
  credential = options.credential
  // Above the content handlers, below nothing that matters: the /_db and
  // /api/_db namespaces are reserved for framework routes (convention 10),
  // so priority only needs to beat ApiHandler (70) for the /api half.
  Bakery.handlers.fetch.set(DbExplorerHandler, 115)
}
