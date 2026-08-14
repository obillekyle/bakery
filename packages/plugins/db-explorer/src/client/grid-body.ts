/**
 * What goes *inside* a cell: the text, the classes, and the foreign-key button.
 *
 * Split out of `grid.ts` alongside the header and the row bar. This half is the
 * one with no knowledge of the cursor or the editor — it is handed a value and
 * returns a node — which is why it could leave.
 *
 * The `<button>` for a foreign key is a real button rather than a styled span,
 * because it is activated by keyboard and read as an action by a screen reader.
 * A `div` with a click handler is neither.
 */

import { button } from './dom'
import {
  type FkResolver,
  type FkTarget,
  fkForColumn,
  fkKeyOf,
  fkLabel,
} from './fk'
import { cellProps, type SchemaColumn, type SchemaGraph } from './meta'

export interface CellPaintContext {
  table: string
  graph: SchemaGraph | null
  resolver: FkResolver
  onFollowFk: (target: FkTarget, key: Record<string, unknown>) => void
}

/**
 * Write one cell's value into its `<td>`.
 *
 * The staged flag is passed in rather than read from a session here, so this
 * module needs no `EditSession` — a staged value and a stored value take
 * exactly the same path and cannot diverge in how they look.
 */
export function paintCell(
  td: HTMLTableCellElement,
  ctx: CellPaintContext,
  row: Record<string, unknown>,
  column: SchemaColumn,
  value: unknown,
  staged: boolean,
): void {
  const props = cellProps(value, column)
  td.replaceChildren()
  td.className = props.className
  if (staged) td.classList.add('staged')
  if (props.title) td.title = props.title
  td.appendChild(cellBody(ctx, row, column, value))
}

function cellBody(
  ctx: CellPaintContext,
  row: Record<string, unknown>,
  column: SchemaColumn,
  value: unknown,
): Node {
  const target = fkForColumn(ctx.graph, ctx.table, column.name)
  const key = target ? fkKeyOf(target, row) : null
  const text = cellProps(value, column).text
  if (!target || !key) return document.createTextNode(text)
  return fkButton(ctx, target, key, text)
}

/**
 * A foreign key as a link, resolving its label on hover.
 *
 * The resolver owns the delay, the cache and the cancellation — see `fk.ts`.
 * All that happens here is arming it on `pointerenter` and disarming it on
 * `pointerleave`, which is what keeps a sweep across the grid from costing
 * fifty round trips.
 */
function fkButton(
  ctx: CellPaintContext,
  target: FkTarget,
  key: Record<string, unknown>,
  text: string,
): HTMLButtonElement {
  const node = button(text, () => ctx.onFollowFk(target, key), {
    class: 'fk',
    title: `→ ${target.refTable}`,
  })

  const show = (resolved: Record<string, unknown> | null) => {
    const label = fkLabel(ctx.graph, target.refTable, resolved)
    node.title = label ? `${target.refTable}: ${label}` : `→ ${target.refTable}`
    if (label) node.textContent = `${text} · ${label}`
  }

  const cached = ctx.resolver.cached(target.refTable, key)
  if (cached !== undefined) show(cached)

  let disarm: (() => void) | null = null
  node.addEventListener('pointerenter', () => {
    disarm = ctx.resolver.arm(target.refTable, key, show)
  })
  node.addEventListener('pointerleave', () => {
    disarm?.()
    disarm = null
  })
  return node
}
