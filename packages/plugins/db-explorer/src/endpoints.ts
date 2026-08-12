import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { Try } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { connection } from '@bakery-framework/orm/connection'

/**
 * The explorer's whole write surface, enumerated: there is none.
 *
 * Both endpoints are reads, there is no raw-SQL endpoint, and no row
 * mutations — that is the plugin's contract, not a configuration. The
 * dashboard's `DASHBOARD_ALLOW_WRITES` gate exists because the dashboard
 * *has* write paths to gate; the explorer removes the paths instead of
 * gating them, so there is no flag to leave set by accident and no second
 * write path for a gate to miss.
 */

export async function handleSchema(): Promise<JsonResponseData<unknown>> {
  return await Try.return(
    async () => response.json.success('success', await connection.getSchema()),
    () => response.json.error(500, 'Failed to retrieve schema details'),
  )
}

/** Table names the way the ORM writes them: identifier characters only. */
const RX_TABLE_NAME = /^[a-zA-Z0-9_]+$/

export async function handleTableData(
  url: URL,
): Promise<JsonResponseData<unknown>> {
  const tableName = url.searchParams.get('tableName')
  if (!tableName || !RX_TABLE_NAME.test(tableName)) {
    return response.json.error(400, 'Invalid table name')
  }

  return await Try.return(
    async () => {
      const data = await connection.getData(tableName, {
        page: Number.parseInt(url.searchParams.get('page') || '1', 10),
        pageSize: Number.parseInt(url.searchParams.get('pageSize') || '50', 10),
        sortBy: url.searchParams.get('sortBy'),
        sortOrder: url.searchParams.get('sortOrder') || 'ASC',
        filters: JSON.parse(url.searchParams.get('filters') || '{}'),
      })
      return response.json.success('success', data)
    },
    (error: any) => response.json.error(400, error.message),
  )
}
