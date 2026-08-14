/**
 * What the server said about a column, and the four decisions the grid makes
 * from it.
 *
 * **Pure — no DOM.** Every branch the editor would otherwise take on a column's
 * type is resolved here, once, into a `WidgetKind`, and every consumer
 * dispatches through a record of small functions rather than an if-chain. A
 * record of five functions has no cognitive complexity; five `else if`s have
 * one arm each, and that is the whole reason `renderTable` in the old client
 * scored 34.
 *
 * The shapes below mirror `endpoints/read.ts` exactly. They are re-declared
 * rather than imported because that module reaches for the ORM and for
 * `node:async_hooks` through its neighbours, and this one is compiled into the
 * browser bundle.
 */

import type { ColumnKind, ColumnMeta } from '../shared/coerce'

export interface SchemaColumn {
  name: string
  type: string
  notnull: boolean
  pk: boolean
  kind: string
  nullable: boolean
  length?: number
  enum?: readonly string[]
  hasDefault: boolean
  autoIncrement?: boolean
}

export interface Identity {
  mode: 'pk' | 'unique' | 'none'
  cols: string[]
  reason?: string
}

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
  /** Optional so a fixture — and an older server — need not carry them. */
  indexes?: SchemaIndex[]
  isView?: boolean
  writable: boolean
  reason?: string
}

export interface SchemaReport {
  access: 'read' | 'write' | false
  tables: SchemaTable[]
}

export interface TablePage {
  rows: Record<string, unknown>[]
  totalRows?: number
  totalPages?: number
  page?: number
  pageSize?: number
}

export interface ForeignKeyInfo {
  table: string
  cols: string[]
  refTable: string
  refCols: string[]
  name?: string
}

export interface SchemaGraph {
  foreignKeys: Record<string, ForeignKeyInfo>
  identity: Record<string, Identity>
  labels: Record<string, string | null>
}

/** Which editor a column gets. The discriminant every dispatch keys on. */
export type WidgetKind = 'enum' | 'boolean' | 'date' | 'json' | 'text'

/**
 * `enum` first, because it is a constraint on a `string` column rather than a
 * kind of its own — the server reports `kind: 'string'` with an `enum` list,
 * and a free-text box over a checked list is a guaranteed round trip to a
 * `not_in_enum` error.
 */
export function columnKind(column: SchemaColumn): WidgetKind {
  if (column.enum?.length) return 'enum'
  if (column.kind === 'boolean') return 'boolean'
  if (column.kind === 'date') return 'date'
  if (column.kind === 'json') return 'json'
  return 'text'
}

/**
 * The `ColumnMeta` `coerceValue` takes.
 *
 * The wire shape and the coercer's shape are nearly the same object and are
 * deliberately not the same type: `kind` crosses the wire as a plain `string`
 * because JSON has no unions, and this is the one place it is narrowed back.
 */
export function columnMeta(column: SchemaColumn): ColumnMeta {
  return {
    kind: column.kind as ColumnKind,
    nullable: column.nullable,
    length: column.length,
    enum: column.enum,
    hasDefault: column.hasDefault,
    primary: column.pk,
    autoIncrement: column.autoIncrement,
  }
}

/**
 * A cell's text.
 *
 * `NULL` is rendered as the word and styled as absent, which is the
 * distinction the whole editor turns on: an empty string is a value and a
 * blank cell would make the two look identical. Binary is summarised rather
 * than dumped — a blob rendered as its bytes is thousands of characters of
 * noise that also makes the row unselectable.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Uint8Array) return `${value.byteLength} bytes`
  if (typeof value === 'object') return safeJson(value)
  return String(value)
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    // A cycle or a BigInt. The cell still has to render something, and the
    // failure is cosmetic — the value itself is untouched.
    return String(value)
  }
}

/** Class names for a rendered cell: the base, plus what the value is. */
export function cellClass(value: unknown, column: SchemaColumn): string {
  const classes = ['cell', `k-${columnKind(column)}`]
  if (value === null || value === undefined) classes.push('null')
  if (column.pk) classes.push('pk')
  if (typeof value === 'number' || typeof value === 'bigint') {
    classes.push('num')
  }
  return classes.join(' ')
}

export interface CellProps {
  text: string
  className: string
  /** The untruncated value, when the cell shows less than all of it. */
  title?: string
}

/** Everything a cell needs, as data. The DOM half only assigns these three. */
export function cellProps(value: unknown, column: SchemaColumn): CellProps {
  const text = cellText(value)
  return {
    text,
    className: cellClass(value, column),
    title: text.length > 60 ? text : undefined,
  }
}

/**
 * Table names as the two halves of the system spell them.
 *
 * `getForeignKeys()` reports whatever the database calls a table while
 * `getConstraints()` is camel-keyed, and the graph endpoint passes both
 * through untouched. Comparing them literally makes every foreign key on a
 * `snake_case` schema invisible, which is the entire feature silently absent.
 */
export function sameTable(a: string, b: string): boolean {
  return a === b || flatten(a) === flatten(b)
}

function flatten(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '')
}
