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

/**
 * A foreign key as the database reports it.
 *
 * Identity is the tuple, not the name: SQLite's `PRAGMA foreign_key_list` does
 * not return a constraint name at all, so keying on one would make every SQLite
 * foreign key look new on every sync.
 */
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

/**
 * The diff, as one value: what `sync/plan.ts` decided and `sync/execute.ts`
 * applies.
 *
 * It lives here rather than beside `buildSyncPlan` because `sync/rename.ts` and
 * `sync/diff.ts` both mutate a plan and are both imported *by* the planner. A
 * home in `plan.ts` would make that pair of edges circular — type-only, and so
 * erased under `verbatimModuleSyntax`, but this repo has been bitten by import
 * cycles often enough that not creating one is worth more than the adjacency.
 */
export namespace SyncPlan {
  export interface TableRename {
    oldName: string
    newName: string
  }
  export interface ColumnDrop {
    table: string
    column: string
  }
  export interface ColumnAdd {
    table: string
    column: string
    def: ColumnConstraint
  }
  export interface ColumnRename {
    table: string
    oldColumn: string
    newColumn: string
  }
}

export interface SyncPlan {
  tablesToDrop: string[]
  tablesToRename: SyncPlan.TableRename[]
  columnsToDrop: SyncPlan.ColumnDrop[]
  columnsToAdd: SyncPlan.ColumnAdd[]
  columnsToRename: SyncPlan.ColumnRename[]
  tablesToRebuild: Set<string>
  /** Which source `dbConstraintsForDiff` came from, so the run can say so. */
  ledgerSource?: 'ledger' | 'introspection'
  ledgerReason?: string
  viewsToUpdate: string[]
  unmappedTsTables: Set<string>
  dbConstraintsForDiff: DBConstraints
}

export type DBForeignKeys = Record<string, ForeignKeyInfo>

export type DBConstraints = Record<string, TableConstraints>

export type DBIndexes = Record<string, IndexConstraint>
