import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { Try } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { connection } from '@bakery-framework/orm/connection'

/**
 * What is left of the console's database surface: two read-only endpoints.
 *
 * The grid editor and the SQL prompt that used to live here are retired —
 * `@bakery-framework/plugin-db-explorer` does the same work with an access
 * model instead of an environment flag, and the console's Database tab is now
 * a link to it. Gone with them: `handleQuery`, `handleExecuteAction`, the
 * statement classifier in `sql-classify.ts`, and `DASHBOARD_ALLOW_WRITES`.
 *
 * The flag is not deprecated, it is *absent*. Nothing here reads it, so
 * setting it has no effect at all — which is the honest state for a console
 * that can no longer write.
 */

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
