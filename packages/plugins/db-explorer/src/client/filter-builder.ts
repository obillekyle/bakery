/**
 * The filter builder: a chip per condition, combinable and each removable.
 *
 * This replaces a row of one text box per column, which could only ever mean
 * "contains" and which grew a box for every column whether or not anyone wanted
 * to filter on it. A chip is column + operator + value + remove, and the
 * operator is the part that was missing: `eq` is what lets a foreign-key jump
 * name a row, and `null` / `notnull` are the two questions a substring box
 * cannot ask at all.
 *
 * The vocabulary and the wire shape are in `shared/filters.ts`, shared with the
 * endpoint that validates them. Nothing here decides what an operator means.
 */

import type { Filter, FilterOp } from '../shared/filters'
import {
  duplicateColumns,
  FILTER_OPS,
  filter as makeFilter,
  OP_LABELS,
  opTakesValue,
} from '../shared/filters'
import { append, box, button, each, el, on, select } from './dom'
import type { SchemaColumn } from './meta'

export interface FilterBuilderContext {
  columns: readonly SchemaColumn[]
  filters: readonly Filter[]
  /** Called with the whole new list; the caller re-fetches and repaints. */
  onChange: (filters: Filter[]) => void
}

const OPTIONS = FILTER_OPS.map(op => ({ value: op, label: OP_LABELS[op] }))

/**
 * The bar.
 *
 * Every control writes a **whole new list** through `onChange` rather than
 * mutating the one it was given — same discipline as the CSV wizard's model,
 * and the reason a chip's state can never disagree with the URL.
 */
export function filterBar(ctx: FilterBuilderContext): HTMLElement {
  const bar = box('filter-bar')
  each(bar, ctx.filters, (entry, index) => chip(ctx, entry, index))
  bar.appendChild(addButton(ctx))

  const clashes = duplicateColumns(ctx.filters)
  if (clashes.length) bar.appendChild(clashNote(clashes))
  return bar
}

/**
 * A column named twice, said out loud.
 *
 * The wire shape is a record keyed by column, so only the last filter on a
 * column is sent. Rendering both chips and silently dropping one would be a
 * screen that disagrees with the query — the one failure mode a filter builder
 * must not have.
 */
function clashNote(columns: readonly string[]): HTMLElement {
  return el('span', {
    class: 'filter-clash',
    text: `only the last filter on ${columns.join(', ')} is applied`,
    title:
      'the table-data endpoint keys filters by column, so a column can carry ' +
      'one condition at a time',
  })
}

function addButton(ctx: FilterBuilderContext): HTMLElement {
  const first = ctx.columns[0]
  const add = button(
    '+ filter',
    () => {
      if (!first) return
      ctx.onChange([...ctx.filters, makeFilter(first.name, 'eq', '')])
    },
    { class: 'btn filter-add', title: 'add a condition' },
  )
  add.disabled = !first
  return add
}

function chip(
  ctx: FilterBuilderContext,
  entry: Filter,
  index: number,
): HTMLElement {
  const node = box('filter-chip')
  const replace = (next: Filter) =>
    ctx.onChange(withAt(ctx.filters, index, next))

  append(node, [
    columnPicker(ctx, entry, replace),
    operatorPicker(entry, replace),
    valueInput(entry, replace),
    removeButton(ctx, entry, index),
  ])
  return node
}

function columnPicker(
  ctx: FilterBuilderContext,
  entry: Filter,
  replace: (next: Filter) => void,
): HTMLElement {
  const options = ctx.columns.map(column => ({
    value: column.name,
    label: `${column.name} · ${column.type}`,
  }))
  return select(options, entry.column, value =>
    replace({ ...entry, column: value }),
  )
}

function operatorPicker(
  entry: Filter,
  replace: (next: Filter) => void,
): HTMLElement {
  return select(OPTIONS, entry.op, value =>
    // Switching to a nullary operator clears the operand rather than keeping
    // it hidden: a value that is invisible and still in the URL is a filter
    // nobody can see and nobody asked for.
    replace(nextOnOp(entry, value as FilterOp)),
  )
}

function nextOnOp(entry: Filter, op: FilterOp): Filter {
  return { ...entry, op, value: opTakesValue(op) ? entry.value : '' }
}

/**
 * The operand — **absent** for `null` and `notnull`.
 *
 * Not disabled, not hidden by CSS: not built at all. A greyed-out box still
 * says "there is a value here", and there is not one.
 */
function valueInput(
  entry: Filter,
  replace: (next: Filter) => void,
): HTMLElement | null {
  if (!opTakesValue(entry.op)) return null
  const input = el('input', {
    class: 'filter-value',
    attrs: {
      'aria-label': `${entry.column} ${OP_LABELS[entry.op]}`,
      placeholder: 'value',
    },
  })
  input.value = entry.value
  on(input, 'change', () => replace({ ...entry, value: input.value }))
  return input
}

function removeButton(
  ctx: FilterBuilderContext,
  entry: Filter,
  index: number,
): HTMLElement {
  return button('×', () => ctx.onChange(withoutAt(ctx.filters, index)), {
    class: 'btn filter-drop',
    title: `remove the filter on ${entry.column}`,
    attrs: { 'aria-label': `remove the filter on ${entry.column}` },
  })
}

/**
 * Immutable list edits.
 *
 * Exported because they are the two operations the chip callbacks are made of,
 * and an off-by-one in either would present as "removing one filter removed a
 * different one" — a bug worth a test rather than a careful read.
 */
export function withAt(
  filters: readonly Filter[],
  index: number,
  next: Filter,
): Filter[] {
  return filters.map((entry, at) => (at === index ? next : entry))
}

export function withoutAt(filters: readonly Filter[], index: number): Filter[] {
  return filters.filter((_entry, at) => at !== index)
}

/**
 * The filter a foreign-key jump becomes.
 *
 * One `eq` per referenced column, which is exactly a row identity — this is the
 * function that replaced `ViewState.focus`. Values stringify because the wire
 * carries text and the ORM binds it as a parameter; the comparison happens in
 * the database, against the column's own type.
 */
export function equalityFilters(key: Record<string, unknown>): Filter[] {
  return Object.entries(key)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([column, value]) => makeFilter(column, 'eq', String(value)))
}
