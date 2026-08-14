/**
 * Step four: the first ten rows exactly as they will be written.
 *
 * The preview recomputes on **every** mapping change, which is the point: a
 * user changing one `<select>` sees immediately that a column now coerces, or
 * now does not. Ten rows keeps that instant on a fifty-thousand-row file.
 *
 * A coerced value that differs from the text carries the text as its `title`,
 * so `"007"` landing in an integer column is visibly `7` and traceably `007`.
 * A failure is ringed and shows the reason `coerceValue` gave — the same
 * sentence the server would have returned.
 */

import {
  type ImportModel,
  previewRows,
  type RowPreview,
  setEmptyToNull,
} from './csv-model'
import { box, each, el, on } from './dom'
import type { SchemaColumn } from './meta'

export function paintPreview(
  node: HTMLElement,
  columns: SchemaColumn[],
  model: ImportModel,
  update: (next: ImportModel) => void,
): void {
  node.replaceChildren()
  const rows = previewRows(model, columns, 10)
  node.appendChild(el('h4', { text: 'Preview' }))
  if (!rows.length) {
    node.appendChild(el('p', { class: 'note', text: 'nothing to import yet' }))
    return
  }

  const table = el('table', { class: 'grid' })
  const head = el('tr')
  const names = rows[0]!.cells.map(cell => cell.column)
  each(head, names, column => el('th', { text: column }))
  table.append(head, nullToggleRow(model, names, update))
  each(table, rows, row => previewRow(row))
  node.appendChild(box('scroll', table))
}

/**
 * A per-column `empty → NULL` switch, sitting under the header where the
 * column it governs is.
 *
 * On by default for every kind except text, because `''` is a value in a text
 * column and an error in every other one — see `defaultEmptyToNull`.
 */
function nullToggleRow(
  model: ImportModel,
  columns: readonly string[],
  update: (next: ImportModel) => void,
): HTMLElement {
  const tr = el('tr')
  each(tr, columns, column => {
    const td = el('td')
    const check = el('input', {
      attrs: { 'aria-label': `${column}: empty becomes NULL` },
    })
    check.type = 'checkbox'
    check.checked = model.emptyToNull[column] ?? false
    on(check, 'change', () =>
      update(setEmptyToNull(model, column, check.checked)),
    )
    const label = el('label', {
      class: 'note',
      text: ' ∅',
      title: 'empty → NULL',
    })
    label.prepend(check)
    td.appendChild(label)
    return td
  })
  return tr
}

function previewRow(row: RowPreview): HTMLElement {
  const tr = el('tr')
  each(tr, row.cells, cell => {
    const text = cell.ok ? String(cell.value ?? 'NULL') : cell.raw
    const td = el('td', { class: cell.ok ? 'cell' : 'cell bad', text })
    if (!cell.ok) td.title = cell.message ?? ''
    else if (text !== cell.raw) td.title = cell.raw
    return td
  })
  return tr
}
