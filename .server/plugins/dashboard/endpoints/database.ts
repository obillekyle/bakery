import { processBody } from '@server/utils'
import { is, Try } from '@server/utils/common'
import { response } from '@server/utils/http'
import { getElapsed } from '@server/logger'
import { connection } from '@database/connection'

export async function handleSchema() {
  return await Try.return(
    async () => response.json.success('success', await connection.getSchema()),
    () => response.json.error(500, 'Failed to retrieve schema details'),
  )
}

export async function handleTableData(url: URL) {
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

export async function handleQuery(req: Request) {
  const body = await processBody(req)
  if (!is.string(body?.sql))
    return response.json.error(400, 'Invalid SQL query')

  const sqlLower = body.sql.trim().toLowerCase()
  const isSelect = /^(select|with|show|describe|pragma|explain)/.test(sqlLower)
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

const executeActionHandlers: Record<
  string,
  (body: any, connection: any) => Promise<any>
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

export async function handleExecuteAction(req: Request) {
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
