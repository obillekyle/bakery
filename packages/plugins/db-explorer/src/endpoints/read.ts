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
import { parseFilters } from '../shared/filters'

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

/** A declared index, as the Structure view lists it. */
export interface SchemaIndex {
  name: string
  type: string
  cols: string[]
}

export interface SchemaTable {
  name: string
  rowCount: number
  columns: SchemaColumn[]
  identity: Identity
  /**
   * Declared indexes.
   *
   * `introspect()` has always computed these — it walks them to find a usable
   * unique key when there is no primary key — and used to throw them away here.
   * The Structure view is the first thing that shows them, and there is no
   * other endpoint that knows them.
   */
  indexes: SchemaIndex[]
  /** Whether this table is a view. A view has no rows of its own to address. */
  isView: boolean
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
      const tables = await introspect({ rowCounts: true })
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
            // The listing asked for counts, so null cannot occur here; the
            // fallback keeps the payload type honest rather than asserting.
            rowCount: table.rowCount ?? 0,
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
            indexes: table.indexes,
            isView: table.isView,
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

/**
 * Read the `filters` parameter, or say why it cannot be read.
 *
 * Split out because it is the one part of this endpoint with a decision in it,
 * and because both failure modes have to be a 400 rather than a silently empty
 * filter set: `JSON.parse` throwing on a mangled parameter, and `parseFilters`
 * rejecting an operator the ORM would otherwise drop. A dropped filter *widens*
 * the result, and the explorer's Delete acts on a selection made from this
 * view — see the header of `shared/filters.ts`.
 */
function readFilters(
  url: URL,
):
  | { ok: true; filters: Record<string, unknown> }
  | { ok: false; error: string } {
  const raw = url.searchParams.get('filters')
  if (!raw) return { ok: true, filters: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A hand-edited or truncated query string. Named as such rather than
    // treated as "no filters", which would answer a question nobody asked.
    return { ok: false, error: 'filters is not valid JSON' }
  }

  const checked = parseFilters(parsed)
  return checked.ok
    ? { ok: true, filters: checked.filters }
    : { ok: false, error: checked.error }
}

export async function handleTableData(
  url: URL,
): Promise<JsonResponseData<unknown>> {
  const tableName = url.searchParams.get('tableName')
  if (!tableName || !RX_TABLE_NAME.test(tableName)) {
    return response.json.error(400, 'Invalid table name')
  }

  const filters = readFilters(url)
  if (!filters.ok) return response.json.error(400, filters.error)

  return await Try.return(
    async () => {
      const data = await connection.getData(tableName, {
        page: Number.parseInt(url.searchParams.get('page') || '1', 10),
        pageSize: Number.parseInt(url.searchParams.get('pageSize') || '50', 10),
        sortBy: url.searchParams.get('sortBy'),
        sortOrder: url.searchParams.get('sortOrder') || 'ASC',
        filters: filters.filters,
      })
      return response.json.success('success', data)
    },
    (error: any) => response.json.error(400, error.message),
  )
}
