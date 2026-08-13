/**
 * The two read endpoints.
 *
 * `/api/_db/schema` now answers with more than the schema: the caller's own
 * access level, and per table whether it is writable and why not. The client
 * needs its posture *before* it renders — a grid that draws edit affordances
 * and then discovers on save that the table has no primary key has already
 * wasted the user's work.
 */

import { Try } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { connection } from '@bakery-framework/orm/connection'
import { currentAccess, currentCanWrite } from '../access'
import { type Identity, introspect } from '../identity'

export interface SchemaColumn {
  name: string
  /** The database's own type string, unchanged — what the grid shows. */
  type: string
  notnull: boolean
  pk: boolean
  /** What the editor coerces against. See `shared/coerce.ts`. */
  kind: string
  nullable: boolean
  length?: number
  enum?: readonly string[]
  hasDefault: boolean
  autoIncrement?: boolean
}

export interface SchemaTable {
  name: string
  rowCount: number
  columns: SchemaColumn[]
  identity: Identity
  writable: boolean
  /** Why not, when `writable` is false. */
  reason?: string
}

export interface SchemaReport {
  access: 'read' | 'write' | false
  tables: SchemaTable[]
}

export async function handleSchema(): Promise<JsonResponseData<unknown>> {
  return await Try.return(
    async () => {
      const tables = await introspect()
      const access = currentAccess()
      const canWrite = currentCanWrite()

      const report: SchemaReport = {
        access,
        tables: [...tables.values()].map(table => {
          // Two independent reasons a table is not writable, and the caller's
          // level is reported first because it is the one that applies to
          // every table at once.
          const reason = !canWrite
            ? 'this session may read but not write'
            : table.identity.reason
          return {
            name: table.name,
            rowCount: table.rowCount,
            columns: table.columns.map(column => ({
              name: column.name,
              type: column.sqlType,
              notnull: !column.meta.nullable,
              pk: Boolean(column.meta.primary),
              kind: column.meta.kind,
              nullable: column.meta.nullable,
              length: column.meta.length,
              enum: column.meta.enum,
              hasDefault: column.meta.hasDefault,
              autoIncrement: column.meta.autoIncrement,
            })),
            identity: table.identity,
            writable: canWrite && table.identity.mode !== 'none',
            reason,
          }
        }),
      }

      return response.json.success('success', report)
    },
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
