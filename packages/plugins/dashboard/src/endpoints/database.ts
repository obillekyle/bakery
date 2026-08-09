import { getElapsed } from '@bakery-framework/core/logger'
import { processBody } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { is, Try } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { connection } from '@bakery-framework/orm/connection'

export async function handleSchema(): Promise<JsonResponseData<unknown>> {
  return await Try.return(
    async () => response.json.success('success', await connection.getSchema()),
    () => response.json.error(500, 'Failed to retrieve schema details'),
  )
}

export async function handleTableData(
  url: URL,
): Promise<JsonResponseData<unknown>> {
  const tableName = url.searchParams.get('tableName')
  if (!tableName || !/^[a-zA-Z0-9_]+$/.test(tableName))
    return response.json.error(400, 'Invalid table name')

  return await Try.return(
    async () => {
      const data = await connection.getData(tableName, {
        page: parseInt(url.searchParams.get('page') || '1', 10),
        pageSize: parseInt(url.searchParams.get('pageSize') || '50', 10),
        sortBy: url.searchParams.get('sortBy'),
        sortOrder: url.searchParams.get('sortOrder') || 'ASC',
        filters: JSON.parse(url.searchParams.get('filters') || '{}'),
      })
      return response.json.success('success', data)
    },
    (error: any) => response.json.error(400, error.message),
  )
}

/**
 * Statements that reach outside the database itself. SQLite's `ATTACH` plus
 * `VACUUM INTO` is an arbitrary file write, which turns any dashboard session
 * (or any XSS in the dashboard origin) into host filesystem access.
 */
const RX_OUT_OF_BAND_SQL = /\b(attach|detach|vacuum\s+into)\b/i

/**
 * Writes from the dashboard need an explicit opt-in.
 *
 * This gate used to sit only in `handleQuery`, so `DELETE FROM t` typed into
 * the SQL box was refused while the grid's Delete and Truncate buttons — which
 * reach the same rows through `execute-action`, with no SQL to inspect — were
 * not. Half a control is worse than none: the production and security
 * checklists both tell operators that leaving `DASHBOARD_ALLOW_WRITES` unset
 * keeps the console read-only, and that was only ever true of one of its two
 * write paths.
 *
 * Read at call time, not at module load: tests set and restore it, and the
 * flag is a deployment decision rather than a build one.
 */
function writesEnabled(): boolean {
  return process.env.DASHBOARD_ALLOW_WRITES === '1'
}

export async function handleQuery(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const body = await processBody(req)
  if (!is.string(body?.sql))
    return response.json.error(400, 'Invalid SQL query')

  if (RX_OUT_OF_BAND_SQL.test(body.sql)) {
    return response.json.error(
      403,
      'ATTACH / DETACH / VACUUM INTO are not permitted from the dashboard.',
    )
  }

  const sqlLower = body.sql.trim().toLowerCase()
  const isSelect = /^(select|with|show|describe|pragma|explain)/.test(sqlLower)

  // Writes require an explicit opt-in; the browser console should not be a
  // one-keystroke path to DROP TABLE on a production database.
  if (!isSelect && !writesEnabled()) {
    return response.json.error(
      403,
      'Write statements are disabled. Set DASHBOARD_ALLOW_WRITES=1 to enable them.',
    )
  }

  const start = Bun.nanoseconds()

  return await Try.return(
    async () => {
      const result = isSelect
        ? { rows: await connection.query(body.sql).all(), isSelect: true }
        : {
            rows: [
              (({ lastInsertRowid, changes }) => ({
                lastInsertRowid,
                changes,
              }))(await connection.query(body.sql).run()),
            ],
            isSelect: false,
          }

      return response.json.success('success', {
        ...result,
        time: getElapsed(start),
      })
    },
    (error: any) =>
      response.json.error(400, error.message, { time: getElapsed(start) }),
  )
}

/**
 * Every branch answers with the JSON envelope — never a `Response` — so the
 * table is typed as such. `data` stays `unknown`: these payloads are arbitrary
 * database rows, and `unknown` says that honestly where `any` would have let
 * the lie back in.
 */
const executeActionHandlers: Record<
  string,
  (body: any, connection: any) => Promise<JsonResponseData<unknown>>
> = {
  'delete-row': async (body, connection) => {
    if (body.rowid == null) return response.json.error(400, 'Invalid row ID')
    return await Try.return(
      async () => {
        await connection.remove(body.tableName, body.rowid)
        return response.json.success('Row deleted')
      },
      (e: any) => response.json.error(400, e.message),
    )
  },
  truncate: async (body, connection) => {
    return await Try.return(
      async () => {
        await connection.truncate(body.tableName)
        return response.json.success('Table truncated')
      },
      (e: any) => response.json.error(400, e.message),
    )
  },
  'insert-row': async (body, connection) => {
    if (!body.row || typeof body.row !== 'object')
      return response.json.error(400, 'Invalid row data')
    return await Try.return(
      async () => {
        await connection.insert(body.tableName, body.row)
        return response.json.success('Row inserted')
      },
      (e: any) => response.json.error(400, e.message),
    )
  },
  'update-row': async (body, connection) => {
    if (
      !body.row ||
      !is.object(body.row) ||
      Array.isArray(body.row) ||
      body.rowid == null
    ) {
      return response.json.error(400, 'Invalid data or row ID')
    }
    return await Try.return(
      async () => {
        await connection.update(body.tableName, body.rowid, body.row)
        return response.json.success('Row updated')
      },
      (e: any) => response.json.error(400, e.message),
    )
  },
  'import-csv': async (body, connection) => {
    if (typeof body.csvContent !== 'string')
      return response.json.error(400, 'Invalid CSV')
    return await Try.return(
      async () => {
        const info = await connection.importCSV(body.tableName, body.csvContent)
        return response.json.success(`Imported ${info.changes} rows`, {
          info,
        })
      },
      (e: any) => response.json.error(400, e.message),
    )
  },
}

export async function handleExecuteAction(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  // Every entry in `executeActionHandlers` writes — truncate and delete-row
  // destroy data outright — so the gate covers the endpoint rather than being
  // repeated per action. Checked before the body is even read.
  if (!writesEnabled()) {
    return response.json.error(
      403,
      'Dashboard writes are disabled. Set DASHBOARD_ALLOW_WRITES=1 to enable them.',
    )
  }

  const body = await processBody(req)
  const { action, tableName } = body || {}

  if (!is.string(tableName) || !/^[a-zA-Z0-9_]+$/.test(tableName)) {
    return response.json.error(400, 'Invalid table name')
  }

  const handler = executeActionHandlers[action]
  if (handler) {
    return await handler(body, connection)
  }
  return response.json.error(400, 'Unknown action')
}
