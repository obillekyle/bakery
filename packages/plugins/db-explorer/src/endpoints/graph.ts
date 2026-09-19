/**
 * What the grid needs to render a foreign key as something other than a number.
 *
 * `/api/_db/graph` is the map, fetched once: every declared foreign key, every
 * table's identity, and the column worth showing instead of an id.
 * `/api/_db/lookup` resolves actual references — **batched, one query per
 * table**, because the shape this replaces is a `fetch` per visible cell, and a
 * fifty-row page with three foreign keys is a hundred and fifty round trips.
 */

import { Try } from '@bakery-framework/core/utils'
import type { JsonResponseData } from '@bakery-framework/core/utils/common'
import { response } from '@bakery-framework/core/utils/http'
import { connection } from '@bakery-framework/orm/connection'
import { qId } from '@bakery-framework/orm/schema-util'
import { type Identity, introspect, type TableFacts } from '../identity'
import { overLimit } from '../policy'
import { findTable, readBody, refuse } from './common'

export async function handleGraph(): Promise<JsonResponseData<unknown>> {
  return await Try.return(
    async () => {
      const [tables, foreignKeys] = await Promise.all([
        introspect(),
        // Composites are already grouped by the adapter, keyed by the tuple
        // rather than by constraint name — SQLite reports no name at all.
        connection.getForeignKeys(),
      ])

      const identity: Record<string, Identity> = {}
      const labels: Record<string, string | null> = {}
      for (const table of tables.values()) {
        identity[table.name] = table.identity
        labels[table.name] = table.label
      }

      return response.json.success('success', {
        foreignKeys,
        identity,
        labels,
      })
    },
    () => response.json.error(500, 'Failed to read the schema graph'),
  )
}

export interface LookupRef {
  table: string
  key: Record<string, unknown>
}

export interface LookupResult {
  table: string
  key: Record<string, unknown>
  row: Record<string, unknown> | null
}

/** A stable string for a set of identity values, for matching rows to refs. */
function fingerprint(cols: readonly string[], row: Record<string, unknown>) {
  // `String(...)` rather than the values themselves: the driver may hand back a
  // `1n` for the `1` that was sent, or a string for a BIGINT, and a lookup that
  // failed to match on that would render every foreign key as "missing".
  return cols.map(col => String(row[col] ?? '\0')).join('\x01')
}

export async function handleLookup(
  req: Request,
): Promise<JsonResponseData<unknown>> {
  const body = await readBody(req)
  if (!body) return response.json.error(400, 'Expected a JSON object body')

  const refs = body.refs
  if (!Array.isArray(refs)) {
    return response.json.error(400, 'refs must be an array')
  }
  const over = overLimit('lookupRefs', refs.length)
  if (over) return response.json.error(413, over)
  if (!refs.length) return response.json.success('success', { rows: [] })

  return await Try.return(
    async () => {
      const tables = await introspect()

      // Grouped first, queried second. One query per *table*, never one per
      // ref.
      const byTable = new Map<string, { table: TableFacts; refs: number[] }>()
      const parsed: (LookupRef | null)[] = refs.map((ref: any, index) => {
        if (typeof ref?.table !== 'string' || typeof ref?.key !== 'object') {
          return null
        }
        const table = findTable(tables, ref.table)
        if (!table || table.identity.mode === 'none') return null
        const group = byTable.get(table.name) ?? { table, refs: [] }
        group.refs.push(index)
        byTable.set(table.name, group)
        return { table: table.name, key: ref.key as Record<string, unknown> }
      })

      const results: LookupResult[] = refs.map((ref: any, index) => ({
        table: String(ref?.table ?? ''),
        key: (parsed[index]?.key ?? {}) as Record<string, unknown>,
        row: null,
      }))

      for (const { table, refs: indexes } of byTable.values()) {
        const cols = table.identity.cols
        const params: unknown[] = []
        const groups: string[] = []
        const wanted = new Map<string, number[]>()

        for (const index of indexes) {
          const key = parsed[index]!.key
          // A ref whose key does not name exactly the identity is skipped
          // rather than widened — a partial key is a predicate over more than
          // one row, which is the bug `validateKey` refuses for a write and
          // there is no reason to accept it for a read.
          if (cols.some(col => !(col in key))) continue
          groups.push(
            `(${cols
              .map(col => {
                params.push(key[col])
                return `${qId(col)} = ?`
              })
              .join(' AND ')})`,
          )
          const print = fingerprint(cols, key)
          wanted.set(print, [...(wanted.get(print) ?? []), index])
        }
        if (!groups.length) continue

        const rows = (await connection
          .query(
            `SELECT * FROM ${qId(table.name)} WHERE ${groups.join(' OR ')}`,
          )
          .all(...params)) as Record<string, unknown>[]

        for (const row of rows) {
          for (const index of wanted.get(fingerprint(cols, row)) ?? []) {
            results[index]!.row = row
          }
        }
      }

      return response.json.success('success', { rows: results })
    },
    error => refuse('lookup', error),
  )
}
