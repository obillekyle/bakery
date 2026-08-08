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
   * **Now part of the column diff**, so widening a `Varchar` migrates. This
   * used to say the opposite, and the reason was sound at the time: it needed
   * every adapter to report the width back exactly, and any that did not would
   * rebuild the table on every sync. That is no longer a guess — all three
   * were measured against live servers, and the one real trap (MySQL reporting
   * `character_maximum_length = 65535` for an unsized `TEXT`) is handled in
   * `SQLAdapter.sizedTextLength`.
   *
   * Compared only when both the schema and the database declare a width. An
   * unsized column in the schema is not a request to shrink whatever is there.
   */
  length?: number
  /**
   * The permitted values of an enum column — `Field.Enum([...])`.
   *
   * Not part of the column diff, for exactly the reason `length` is not:
   * MySQL reports an ENUM's members back in its own spelling, Postgres reports
   * a CHECK constraint from a different catalog altogether, and any adapter
   * that reported them even slightly differently would rebuild the table on
   * every sync. Consequence to know, and it is the same one: **changing an
   * enum's members does not migrate on its own.**
   */
  _enum?: string[]
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
/**
 * Referential actions, normalised to the SQL spelling.
 *
 * One vocabulary for three dialects: MySQL and SQLite report these words back
 * verbatim, Postgres reports single characters (`c`, `a`, `r`, `n`, `d`) which
 * the adapter maps. Without one normal form the diff would compare `CASCADE`
 * against `c` and drop-and-recreate the key on every sync.
 */
export type ForeignKeyAction =
  | 'NO ACTION'
  | 'RESTRICT'
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT'

export interface ForeignKeyInfo {
  table: string
  cols: string[]
  refTable: string
  refCols: string[]
  name?: string
  /** Defaults to `NO ACTION`, which is what every dialect emits when omitted. */
  onDelete?: ForeignKeyAction
  onUpdate?: ForeignKeyAction
}

export type DBForeignKeys = Record<string, ForeignKeyInfo>

export type DBConstraints = Record<string, TableConstraints>

export type DBIndexes = Record<string, IndexConstraint>

