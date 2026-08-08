export type ColumnType =
  | 'integer'
  | 'string'
  | 'number'
  | 'boolean'
  | 'buffer'
  | 'bigint'
  | 'json'

export interface ColumnConstraint {
  type: ColumnType
  /**
   * Character length, for a sized text column (`VARCHAR(n)`).
   *
   * Deliberately **not** part of the column diff, which compares type,
   * nullability and default only. Adding it there would require every adapter
   * to report the length back exactly, and any that did not would rebuild the
   * table on every sync — the failure this codebase has already hit twice.
   * Consequence to know: widening a `Varchar` does not migrate on its own.
   */
  length?: number
  primary?: boolean
  autoIncrement?: boolean
  nullable?: boolean
  default?: unknown
  _oldColumn?: string
  _transform?: (oldValue: unknown, oldRow?: Record<string, unknown>) => unknown
}

export type TableConstraints = {
  [column: string]: ColumnConstraint
} & {
  _view?: string
  _oldTable?: string
  _transform?: (oldRow: Record<string, unknown>) => unknown
}

export interface IndexConstraint {
  type: 'index' | 'unique' | 'foreign'
  table: string
  cols: string[]
  /** Set only when `type` is 'foreign'. */
  refTable?: string
  refCols?: string[]
}

/**
 * A foreign key as the database reports it.
 *
 * Identity is the tuple, not the name: SQLite's `PRAGMA foreign_key_list`
 * does not return a constraint name at all, so keying on one would make every
 * SQLite foreign key look new on every sync — the perpetual-rebuild failure
 * this project keeps hitting.
 */
export interface ForeignKeyInfo {
  table: string
  cols: string[]
  refTable: string
  refCols: string[]
  name?: string
}

export type DBForeignKeys = Record<string, ForeignKeyInfo>

export type DBConstraints = Record<string, TableConstraints>

export type DBIndexes = Record<string, IndexConstraint>

