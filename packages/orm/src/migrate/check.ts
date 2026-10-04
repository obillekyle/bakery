import { Case } from '@bakery-framework/core/utils'
import type { SQLAdapter } from '../adapters/base'
import type * as SyncTypes from '../sync/types'

/** One way the declared tables and the database disagree. */
export interface SchemaMismatch {
  /** The table as declared. */
  table: string
  /** The column as declared, when the mismatch is a column's. */
  column?: string
  problem: string
}

/**
 * Compare the declared tables with the database, column by column, reading
 * the catalog and nothing else: what `db:sync` does in migrations mode, where
 * the migration files are the schema and the declarations only type queries.
 *
 * It asks one question of each declared column: would a query typed by this
 * declaration be right about the column? So a table or column the database
 * lacks, a type the declaration does not accept (each adapter's rules, see
 * `adapters/live-types.ts`), a disagreement about NULL, and a primary key in
 * the wrong place are mismatches. A table or column the database has and the
 * declarations leave out is not: queries simply never name it.
 *
 * A view's columns are not held to their nullability, since catalogs report
 * every view column as nullable whatever the query beneath it can return.
 */
export async function checkSchema(
  adapter: SQLAdapter,
  declared: SyncTypes.DBConstraints,
): Promise<SchemaMismatch[]> {
  const live = new Map<string, Map<string, SQLAdapter.LiveColumn>>()
  for (const column of await adapter.liveColumns()) {
    let columns = live.get(column.table)
    if (!columns) live.set(column.table, (columns = new Map()))
    columns.set(column.column, column)
  }

  const mismatches: SchemaMismatch[] = []
  for (const [table, constraints] of Object.entries(declared)) {
    const sqlTable = Case.snake(table)
    const columns = live.get(sqlTable)
    if (!columns) {
      mismatches.push({
        table,
        problem: `${sqlTable} is declared, and the database has no table or view by that name.`,
      })
      continue
    }

    for (const [column, def] of Object.entries(constraints)) {
      // `_view`, `_oldTable` and `_transform` sit beside the columns.
      if (column.startsWith('_') || !def || typeof def !== 'object') continue
      const constraint = def as SyncTypes.ColumnConstraint
      const sqlColumn = Case.snake(column)
      const where = `${sqlTable}.${sqlColumn}`
      const liveColumn = columns.get(sqlColumn)
      if (!liveColumn) {
        mismatches.push({
          table,
          column,
          problem: `${where} is declared, and the table has no such column.`,
        })
        continue
      }

      const typeProblem = adapter.columnTypeProblem(constraint, liveColumn)
      if (typeProblem) {
        mismatches.push({ table, column, problem: `${where}: ${typeProblem}.` })
      }
      if (liveColumn.view) continue

      const nullable = Boolean(constraint.nullable) && !constraint.primary
      if (nullable !== liveColumn.nullable) {
        mismatches.push({
          table,
          column,
          problem: nullable
            ? `${where}: declared nullable, and the database has it NOT NULL.`
            : `${where}: declared NOT NULL, and the database allows NULL.`,
        })
      }
      if (constraint.primary && !liveColumn.primary) {
        mismatches.push({
          table,
          column,
          problem: `${where}: declared the primary key, and it is not the database's.`,
        })
      }
    }
  }
  return mismatches
}

/** The `Field.Sql` columns of a schema, as `table.column`, for classic sync to refuse. */
export function sqlColumnsIn(declared: SyncTypes.DBConstraints): string[] {
  const found: string[] = []
  for (const [table, constraints] of Object.entries(declared)) {
    for (const [column, def] of Object.entries(constraints)) {
      if (column.startsWith('_') || !def || typeof def !== 'object') continue
      if ((def as SyncTypes.ColumnConstraint).type === 'sql') {
        found.push(`${table}.${column}`)
      }
    }
  }
  return found
}
