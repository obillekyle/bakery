/**
 * The grid's header row: the select-all box and the sortable column headings.
 *
 * Split out of `grid.ts` when that file passed six hundred lines. It is a clean
 * seam because the header depends on nothing the grid mutates — it is built
 * once from the columns and the current sort, and never repainted. Cursor,
 * editor and selection state all live on the other side of it.
 */

import { each, el, on } from './dom'
import type { SchemaColumn } from './meta'

export interface HeaderContext {
  columns: readonly SchemaColumn[]
  editable: boolean
  sortBy: string | null
  sortOrder: 'ASC' | 'DESC'
  onSort: (column: string) => void
  onToggleAll: (checked: boolean) => void
}

export function buildHead(ctx: HeaderContext): HTMLTableSectionElement {
  const head = el('thead')
  const tr = el('tr')
  tr.appendChild(buildSelectAll(ctx))
  each(tr, ctx.columns, column => buildHeaderCell(ctx, column))
  head.appendChild(tr)
  return head
}

/**
 * The leading column exists on every table, editable or not: it carries the row
 * panel's opener, which a read-only table needs just as much — a forty-column
 * row is unreadable in a grid whether or not it can be changed. The select-all
 * checkbox joins it only when there is something to select *for*.
 */
function buildSelectAll(ctx: HeaderContext): HTMLTableCellElement {
  const th = el('th', { class: 'pick' })
  if (!ctx.editable) return th
  const check = el('input', { attrs: { 'aria-label': 'select all rows' } })
  check.type = 'checkbox'
  on(check, 'change', () => ctx.onToggleAll(check.checked))
  th.appendChild(check)
  return th
}

function buildHeaderCell(
  ctx: HeaderContext,
  column: SchemaColumn,
): HTMLTableCellElement {
  const th = el('th', {
    text: column.name + sortArrow(ctx, column.name),
    title: `${column.type}${column.notnull ? ' NOT NULL' : ''}`,
    attrs: { 'data-kind': column.kind },
  })
  if (column.pk) th.classList.add('pk')
  on(th, 'click', () => ctx.onSort(column.name))
  return th
}

/** Named so the ternary chain is not folded into `buildHeaderCell`'s score. */
function sortArrow(ctx: HeaderContext, column: string): string {
  if (ctx.sortBy !== column) return ''
  return ctx.sortOrder === 'ASC' ? ' ↑' : ' ↓'
}
