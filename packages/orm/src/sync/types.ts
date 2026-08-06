export type ColumnType = 'integer' | 'string' | 'number' | 'boolean' | 'buffer'

export interface ColumnConstraint {
  type: ColumnType
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
  type: 'index' | 'unique'
  table: string
  cols: string[]
}

export type DBConstraints = Record<string, TableConstraints>

export type DBIndexes = Record<string, IndexConstraint>

