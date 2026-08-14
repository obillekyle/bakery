/**
 * The strip that appears under a row the moment it is dirty.
 *
 * Under the row rather than in a toolbar, because "which row is this Save for"
 * has exactly one unambiguous answer and it is proximity. It carries the
 * changed-column list, the two buttons, and the place a failed save reports
 * itself — a 409 belongs next to the row it is about, not in a toast.
 */

import { append, box, button, el } from './dom'

export interface RowBar {
  tr: HTMLTableRowElement
  message: HTMLElement
  count: HTMLElement
}

export interface RowBarHooks {
  onSave: () => void
  onRevert: () => void
}

export function buildRowBar(colSpan: number, hooks: RowBarHooks): RowBar {
  const tr = el('tr', { class: 'row-bar-row' })
  const td = el('td')
  td.colSpan = colSpan

  const bar = box('row-bar')
  const count = el('span', { class: 'note' })
  const message = el('span', { class: 'row-error' })
  append(bar, [
    count,
    button('Save', hooks.onSave, { class: 'btn primary' }),
    button('Revert', hooks.onRevert, { class: 'btn' }),
    message,
  ])

  td.appendChild(bar)
  tr.appendChild(td)
  return { tr, message, count }
}

/**
 * Show the bar, and say what changed.
 *
 * Naming the columns rather than counting them is the point: "3 columns
 * changed" tells you that you touched something and not what, and the whole
 * reason the buffer exists is that a row is saved as one statement.
 */
export function paintRowBar(bar: RowBar, changed: readonly string[]): void {
  bar.tr.classList.toggle('open', changed.length > 0)
  bar.count.textContent = changed.length
    ? `${changed.length} column${changed.length === 1 ? '' : 's'} changed: ${changed.join(', ')}`
    : ''
  // A fresh edit clears a stale failure: the message was about the previous
  // attempt, and leaving it up would make a retry look like it had already
  // failed.
  if (changed.length) bar.message.textContent = ''
}

export function setRowBarMessage(bar: RowBar, message: string): void {
  bar.tr.classList.add('open')
  bar.message.textContent = message
}
