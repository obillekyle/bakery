/**
 * The Structure view: what the table *is*, as opposed to what is in it.
 *
 * Every serious client — DBeaver, DataGrip, Devart — splits a table into Data
 * and its structure, and keeps them apart. This one was the single biggest
 * omission: `GET /api/_db/schema` has always returned the type, nullability,
 * default, enum values, auto-increment flag and resolved row identity of every
 * column, and the client used all of it *only* to pick which editor widget to
 * open. None of it was ever on screen. The reason a table is read-only was the
 * worst of it — it existed, in the server's own words, and appeared nowhere
 * except a tooltip on a padlock.
 *
 * `structureRows` is **pure** and is the whole derivation, so what each column
 * is said to be is asserted rather than eyeballed.
 */

import { append, box, each, el, gridTable } from './dom'
import type { SchemaColumn, SchemaIndex, SchemaTable } from './meta'

/** One row of the columns table, already worded. */
export interface StructureRow {
  name: string
  type: string
  nullable: string
  /** `AUTO`, a literal `DEFAULT`, or empty — never a guess. */
  default: string
  /** `PK`, `unique`, or empty. */
  key: string
  /** The enum members, comma-joined, or empty. */
  values: string
  /** Whether this column is part of the row identity. */
  identity: boolean
}

/**
 * A column as the Structure table shows it.
 *
 * Two decisions worth naming, because both are places a plausible shortcut is
 * wrong:
 *
 *  - **`hasDefault` and `autoIncrement` are different facts**, and an
 *    auto-increment column is reported as such rather than as "has a default".
 *    They differ in the one place it matters — `omittableOnInsert` — and
 *    conflating them on screen would teach the reader the wrong model.
 *  - **`notnull` is not the negation of `nullable` here.** The server sends
 *    both, from two different introspection calls (`getConstraints()` when it
 *    says anything, `getSchema()`'s flag otherwise), and `nullable` is the
 *    richer one. It is the one the editors obey, so it is the one shown.
 */
export function structureRow(
  column: SchemaColumn,
  identityCols: readonly string[],
  indexes: readonly SchemaIndex[] = [],
): StructureRow {
  return {
    name: column.name,
    // The length is appended only when the database's own type string does not
    // already carry it. `getSchema()` reports `VARCHAR(255)` on every dialect
    // that has sized text, so appending unconditionally rendered
    // `VARCHAR(255)(255)`. SQLite's `TEXT` with a declared length is the case
    // that still needs the suffix.
    type:
      column.length && !column.type.includes('(')
        ? `${column.type}(${column.length})`
        : column.type,
    nullable: column.nullable ? 'NULL' : 'NOT NULL',
    default: defaultOf(column),
    key: keyOf(column, indexes),
    values: column.enum?.length ? column.enum.join(', ') : '',
    identity: identityCols.includes(column.name),
  }
}

function defaultOf(column: SchemaColumn): string {
  if (column.autoIncrement) return 'AUTO'
  return column.hasDefault ? 'DEFAULT' : ''
}

/**
 * Primary key first, then unique-index membership.
 *
 * Only `unique` indexes are reported as a key. A plain index makes a column
 * faster to look up and does nothing to make a row nameable, and calling both
 * "key" is how someone concludes a table is addressable when it is not.
 */
function keyOf(column: SchemaColumn, indexes: readonly SchemaIndex[]): string {
  if (column.pk) return 'PK'
  const unique = indexes.some(
    index => index.type === 'unique' && index.cols.includes(column.name),
  )
  return unique ? 'unique' : ''
}

export function structureRows(table: SchemaTable): StructureRow[] {
  return table.columns.map(column =>
    structureRow(column, table.identity.cols, table.indexes ?? []),
  )
}

// --------------------------------------------------------------------- render

const HEADINGS = [
  'column',
  'type',
  'null',
  'default',
  'key',
  'values',
  'identity',
] as const

const INDEX_HEADINGS = ['index', 'type', 'columns'] as const

/**
 * A scrolling table of plain text cells.
 *
 * Columns and indexes are the same table twice — headings, then a `<tr>` of
 * `<td class="cell">` per row — so they are one builder and two `string[][]`.
 */
function dataTable(
  headings: readonly string[],
  rows: readonly (readonly string[])[],
): HTMLElement {
  const grid = gridTable(headings, 'grid structure-grid')
  each(grid, rows, cells => dataRow(cells))
  return box('scroll', grid)
}

function dataRow(cells: readonly string[]): HTMLElement {
  const tr = el('tr')
  each(tr, cells, text => el('td', { class: 'cell', text }))
  return tr
}

export interface StructureContext {
  table: SchemaTable
  editable: boolean
  /** Why not, in the server's words. Shown prominently when not editable. */
  reason: string
}

export function renderStructure(ctx: StructureContext): HTMLElement {
  const node = box('structure')
  append(node, [
    identitySection(ctx),
    columnsSection(ctx.table),
    indexesSection(ctx.table),
  ])
  return node
}

/**
 * How a row of this table is named — and, when it cannot be, why.
 *
 * First rather than last, and a banner rather than a footnote. "This table is
 * read-only" with no reason is the message that generates support questions;
 * the reason has always existed and is the server's own sentence.
 */
function identitySection(ctx: StructureContext): HTMLElement {
  const section = box('structure-section')
  section.appendChild(el('h3', { text: 'Row identity' }))

  const identity = ctx.table.identity
  if (identity.mode === 'none') {
    section.appendChild(
      el('p', {
        class: 'banner warn',
        text: `no row of this table can be named — ${ctx.reason}`,
      }),
    )
    return section
  }

  section.appendChild(
    el('p', {
      class: 'note',
      text:
        `a row is named by its ${identity.mode === 'pk' ? 'primary key' : 'unique index'}: ` +
        identity.cols.join(', '),
    }),
  )
  if (!ctx.editable) {
    section.appendChild(el('p', { class: 'banner warn', text: ctx.reason }))
  }
  return section
}

function columnsSection(table: SchemaTable): HTMLElement {
  const section = box('structure-section')
  section.appendChild(el('h3', { text: `Columns (${table.columns.length})` }))
  section.appendChild(
    dataTable(HEADINGS, structureRows(table).map(columnCells)),
  )
  return section
}

/** A `StructureRow` in `HEADINGS` order. The only place the two are paired. */
function columnCells(row: StructureRow): string[] {
  return [
    row.name,
    row.type,
    row.nullable,
    row.default,
    row.key,
    row.values,
    row.identity ? '✓' : '',
  ]
}

/**
 * Indexes, or an explicit statement that there are none.
 *
 * An empty section beats an absent one: "this table has no indexes" is an
 * answer, and a missing heading reads as a client that failed to load them.
 */
function indexesSection(table: SchemaTable): HTMLElement {
  const section = box('structure-section')
  const indexes = table.indexes ?? []
  section.appendChild(el('h3', { text: `Indexes (${indexes.length})` }))

  if (!indexes.length) {
    section.appendChild(
      el('p', { class: 'note', text: 'no indexes are declared on this table' }),
    )
    return section
  }

  section.appendChild(dataTable(INDEX_HEADINGS, indexes.map(indexCells)))
  return section
}

function indexCells(index: SchemaIndex): string[] {
  return [index.name, index.type, index.cols.join(', ')]
}
