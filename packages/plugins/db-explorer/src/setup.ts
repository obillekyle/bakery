import { bundleModule } from '@bakery-framework/core/compiler'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { Handler } from '@bakery-framework/core/handlers'
import { errorMsg } from '@bakery-framework/core/logger'
import type { PluginRouteTable } from '@bakery-framework/core/plugins'
import { routeTable } from '@bakery-framework/core/plugins'
import { fs } from '@bakery-framework/core/utils'
import { response } from '@bakery-framework/core/utils/http'
import { type AccessConfig, accessStore, resolveAccess } from './access'
import { handleGraph, handleLookup } from './endpoints/graph'
import { handleImport } from './endpoints/import'
import { handleSchema, handleTableData } from './endpoints/read'
import {
  handleBulkEdit,
  handleDeleteRows,
  handleInsertRows,
  handleUpdateRow,
} from './endpoints/rows'
import { SHELL } from './shell'

/**
 * Where this plugin's own files live — each package that ships files anchors
 * to its own location, never to core's (see the dashboard's `paths.ts` for
 * the 404s that lesson cost).
 */
const pluginRoot: string = fs.resolve(import.meta.dir)

let config: AccessConfig = {}

/**
 * Test seam: `setupExplorer` registers a handler and cannot be undone, so
 * tests that only need the request pipeline set the access config directly.
 * Always pair with the reset.
 */
export function __setTestAccess(next: AccessConfig): void {
  config = next
}

export function __resetTestAccess(): void {
  config = {}
}

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
 * The whole request surface, and **the key spellings are the CSRF policy** —
 * `guardFor` in `plugins/routes.ts` reads them, so getting one wrong here
 * silently loosens a guard rather than failing anywhere visible.
 *
 * - **Bare keys are the reads.** A bare key matches every method and gets
 *   `checkSameOrigin` on *all* of them, which is the stricter of the two: no
 *   cross-site page reaches these, whatever verb it uses.
 * - **Every write key names its method.** That pins the verb — a `GET
 *   /api/_db/rows` no longer resolves at all — and applies `checkCsrf`.
 *
 * This comment used to say the table needed no CSRF middleware because nothing
 * here could mutate anything. That was true when the plugin was read-only and
 * is now false: rows are inserted, edited and deleted below. What is still
 * true, and is the claim that survives, is **structural**: there is no
 * raw-SQL endpoint and nothing that creates, drops or alters a table. The write
 * surface is bounded and enumerable — it is exactly the six keys below — rather
 * than gated behind a flag the way the dashboard's is.
 *
 * `/api/_db/graph` and `/api/_db/lookup` are reads despite one of them taking a
 * POST body, so they stay bare and take the stricter guard. Method-qualifying
 * `GET /api/_db/graph` would *weaken* it: a qualified GET gets `checkCsrf`,
 * which lets every GET through by definition.
 */
export const explorerRoutes = {
  '/_db': () => response.html(SHELL),
  '/_db/app.js': () => handleClientJs(),
  '/api/_db/schema': () => handleSchema(),
  '/api/_db/table-data': (_req, url) => handleTableData(url),
  '/api/_db/graph': () => handleGraph(),
  '/api/_db/lookup': req => handleLookup(req),
  'POST /api/_db/rows': req => handleInsertRows(req),
  'PATCH /api/_db/row': req => handleUpdateRow(req),
  'POST /api/_db/rows/bulk': req => handleBulkEdit(req),
  'DELETE /api/_db/rows': req => handleDeleteRows(req),
  'POST /api/_db/import': req => handleImport(req),
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
    // dashboard. Everything else fails closed.
    const access = await resolveAccess(req, config)
    if (!/\.(css|js)$/.test(path) && !access) {
      return path.startsWith('/api/')
        ? response.error('Unauthorized', 401)
        : response.error('Not Found', 404)
    }

    // The level travels with the request rather than in a module variable —
    // see `accessStore`. `read` is the floor for the asset paths admitted
    // above, which never consult it but must not run outside a store.
    return await accessStore.run(access || 'read', async () => {
      // Dispatch keys on `url.pathname` from the request itself — the `path`
      // argument only steers the auth split above.
      const result = await dispatchExplorerRoute(req)
      return result ?? response.error('Not Found', 404)
    })
  }
}

export function setupExplorer(options: AccessConfig = {}) {
  config = options
  // Above the content handlers, below nothing that matters: the /_db and
  // /api/_db namespaces are reserved for framework routes (convention 10),
  // so priority only needs to beat ApiHandler (70) for the /api half.
  Bakery.handlers.fetch.set(DbExplorerHandler, 115)
}
