/**
 * The editable grid: which node holds which value, and where focus is.
 *
 * Two rules keep this file's functions under biome's complexity ceiling, and
 * they are worth stating because the old `renderTable` broke both and scored
 * 34 with a fraction of the behaviour:
 *
 *  1. **No function both fetches and renders.** Everything here takes rows it
 *     was handed. `api.ts` does the asking.
 *  2. **Every loop body is a named function.** `each()` from `dom.ts` takes the
 *     factory; an inline body would fold its branches into the caller's score.
 *
 * Three neighbours carry the parts that do not need the cursor:
 * `grid-header.ts` builds the heading row, `grid-body.ts` paints a cell's
 * contents, and `grid-rowbar.ts` owns the per-row save strip. The editing model
 * itself is in `edit-session.ts` and the keyboard model in `cell.ts`, both pure
 * and both tested. What is left here genuinely needs a DOM.
 *
 * `focus` used to live here too — a row identity carried alongside the filters,
 * because a substring `LIKE` could not name a row. With `eq` in the filter
 * vocabulary a foreign-key jump is an ordinary filter, and the highlight, the
 * `focusedMissing()` note and the whole concept are gone.
 */

import { afterCommit, type CellAction, type CellState, keyOnCell } from './cell'
import { box, each, el, on, setBusy } from './dom'
import type { EditSession } from './edit-session'
import { rowId } from './edit-session'
import { createEditor, type EditorHandle } from './editors'
import type { FkResolver, FkTarget } from './fk'
import { type CellPaintContext, paintCell } from './grid-body'
import { buildHead } from './grid-header'
import {
  buildRowBar,
  paintRowBar,
  type RowBar,
  setRowBarMessage,
} from './grid-rowbar'
import type { SchemaColumn, SchemaGraph, SchemaTable } from './meta'

export interface GridContext {
  table: SchemaTable
  columns: SchemaColumn[]
  rows: Record<string, unknown>[]
  editable: boolean
  graph: SchemaGraph | null
  session: EditSession
  resolver: FkResolver
  sortBy: string | null
  sortOrder: 'ASC' | 'DESC'
  onSort: (column: string) => void
  onSaveRow: (id: string) => void
  onOpenRow: (row: Record<string, unknown>) => void
  onFollowFk: (target: FkTarget, key: Record<string, unknown>) => void
  onSelectionChange: (selected: number) => void
  onDirtyChange: () => void
}

interface RowSlot {
  id: string | null
  row: Record<string, unknown>
  tr: HTMLTableRowElement
  cells: HTMLTableCellElement[]
  bar: RowBar
  check: HTMLInputElement | null
}

export class Grid {
  readonly node: HTMLElement
  private readonly slots: RowSlot[] = []
  private readonly body: HTMLTableSectionElement
  private readonly paintCtx: CellPaintContext
  private cursor = { row: 0, col: 0 }
  private editor: EditorHandle | null = null
  private editing: { row: number; col: number } | null = null
  readonly selected = new Set<string>()

  constructor(private readonly ctx: GridContext) {
    this.paintCtx = {
      table: ctx.table.name,
      graph: ctx.graph,
      resolver: ctx.resolver,
      onFollowFk: ctx.onFollowFk,
    }

    const table = el('table', { class: 'grid' })
    table.appendChild(
      buildHead({
        columns: ctx.columns,
        editable: ctx.editable,
        sortBy: ctx.sortBy,
        sortOrder: ctx.sortOrder,
        onSort: ctx.onSort,
        onToggleAll: checked => this.setAllSelected(checked),
      }),
    )
    this.body = el('tbody')
    table.appendChild(this.body)
    each(this.body, ctx.rows, (row, index) => this.buildRow(row, index))
    this.node = box('scroll', table)
    on(this.node, 'keydown', event => this.onKeyDown(event as KeyboardEvent))
  }

  // -------------------------------------------------------------------- rows

  private buildRow(row: Record<string, unknown>, index: number): Node {
    const id = rowId(row, this.ctx.table.identity.cols)
    const tr = el('tr')
    const check = this.buildPick(tr, row, id)
    const cells: HTMLTableCellElement[] = []
    each(tr, this.ctx.columns, (column, col) => {
      const td = this.buildCell(row, index, column, col)
      cells.push(td)
      return td
    })

    const bar = buildRowBar(this.ctx.columns.length + 1, {
      onSave: () => this.saveRow(index),
      onRevert: () => this.revertRow(index),
    })
    this.slots[index] = { id, row, tr, cells, bar, check }

    // A fragment so one `each` callback can add two rows: the data row and the
    // save/revert bar that lives under it.
    const fragment = document.createDocumentFragment()
    fragment.append(tr, bar.tr)
    return fragment
  }

  /** Selection checkbox (when editable) and the panel opener (always). */
  private buildPick(
    tr: HTMLTableRowElement,
    row: Record<string, unknown>,
    id: string | null,
  ): HTMLInputElement | null {
    const td = el('td', { class: 'pick' })
    let check: HTMLInputElement | null = null
    if (this.ctx.editable) {
      check = el('input', { attrs: { 'aria-label': 'select row' } })
      check.type = 'checkbox'
      check.disabled = id === null
      on(check, 'change', () => this.setSelected(id, check!.checked))
      td.appendChild(check)
    }
    const open = el('button', {
      class: 'btn',
      text: '⋯',
      title: 'open this row',
    })
    open.type = 'button'
    on(open, 'click', () => this.ctx.onOpenRow(row))
    td.appendChild(open)
    tr.appendChild(td)
    return check
  }

  // ------------------------------------------------------------------- cells

  private buildCell(
    row: Record<string, unknown>,
    rowIndex: number,
    column: SchemaColumn,
    col: number,
  ): HTMLTableCellElement {
    const td = el('td', { attrs: { tabindex: -1 } })
    on(td, 'click', () => this.focusCell(rowIndex, col))
    on(td, 'dblclick', () => this.requestEdit(rowIndex, col))
    this.repaintCell(rowIndex, col, td, row, column)
    return td
  }

  /**
   * Render one cell from the session's current view of it.
   *
   * Called on build, after every stage, and after an editor closes — so a
   * staged value and a saved value take exactly the same path.
   */
  private repaintCell(
    rowIndex: number,
    col: number,
    node?: HTMLTableCellElement,
    row?: Record<string, unknown>,
    column?: SchemaColumn,
  ): void {
    const slot = this.slots[rowIndex]
    const td = node ?? slot?.cells[col]
    const source = row ?? slot?.row
    const meta = column ?? this.ctx.columns[col]
    if (!td || !source || !meta) return

    const id = slot?.id ?? rowId(source, this.ctx.table.identity.cols)
    const value = id
      ? this.ctx.session.value(id, meta.name, source[meta.name])
      : source[meta.name]
    const staged = id ? this.ctx.session.isStaged(id, meta.name) : false
    paintCell(td, this.paintCtx, source, meta, value, staged)
  }

  // ----------------------------------------------------------------- cursor

  private focusCell(row: number, col: number): void {
    if (this.editing) this.commitEditor('none')
    this.cursor = { row, col }
    const td = this.slots[row]?.cells[col]
    if (!td) return
    for (const other of this.body.querySelectorAll('td.at')) {
      other.classList.remove('at')
    }
    td.classList.add('at')
    td.focus()
  }

  private cellState(): CellState {
    return {
      row: this.cursor.row,
      col: this.cursor.col,
      rows: this.slots.length,
      cols: this.ctx.columns.length,
      editing: this.editing !== null,
      editable: this.ctx.editable,
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    const action = keyOnCell(event, this.cellState())
    if (action.type === 'none') return
    event.preventDefault()
    this.apply(action)
  }

  private apply(action: CellAction): void {
    const handlers: Record<CellAction['type'], () => void> = {
      none: () => {},
      move: () => {
        const move = action as { row: number; col: number }
        this.focusCell(move.row, move.col)
      },
      edit: () => this.requestEdit(this.cursor.row, this.cursor.col),
      cancel: () => this.cancelEditor(),
      null: () => this.stageNull(),
      commit: () => this.commitEditor((action as { move: 'down' }).move),
    }
    handlers[action.type]()
  }

  // ---------------------------------------------------------------- editing

  /**
   * Open an editor — or explain why not.
   *
   * A double-click on a read-only table says what is wrong *here*, at the
   * moment the user asked. The alternative is a grid that looks editable and
   * refuses at save time, after the typing.
   */
  private requestEdit(rowIndex: number, col: number): void {
    this.focusCell(rowIndex, col)
    if (!this.ctx.editable) {
      this.setRowMessage(
        rowIndex,
        this.ctx.table.reason ?? 'this table is read-only',
      )
      return
    }
    const slot = this.slots[rowIndex]
    if (!slot?.id) {
      this.setRowMessage(
        rowIndex,
        'this row carries no identity, so it cannot be addressed',
      )
      return
    }
    this.openEditor(rowIndex, col, slot)
  }

  private openEditor(rowIndex: number, col: number, slot: RowSlot): void {
    const column = this.ctx.columns[col]
    if (!column || !slot.id) return
    const current = this.ctx.session.value(
      slot.id,
      column.name,
      slot.row[column.name],
    )
    const handle = createEditor(column, current, {
      // The grid reads the editor at commit time instead of tracking every
      // keystroke, which is what makes Escape a true revert: an uncommitted
      // value was never anywhere the session could see it.
      onInput: () => {},
      onKey: event => this.onKeyDown(event),
    })
    // Blur stages; it never saves. A click into another cell must not be a
    // write, and a multi-column edit must stay one statement.
    //
    // `relatedTarget` is checked because `focusout` also fires for movement
    // *inside* the editor — tabbing from the input to the null toggle is one —
    // and committing there would close the editor the user is still in.
    handle.node.addEventListener('focusout', event => {
      const next = (event as FocusEvent).relatedTarget
      if (next instanceof Node && handle.node.contains(next)) return
      this.stageOnBlur(rowIndex, col)
    })
    const td = slot.cells[col]
    if (!td) return
    td.replaceChildren(handle.node)
    td.classList.add('editing')
    this.editor = handle
    this.editing = { row: rowIndex, col }
    handle.focus()
  }

  private stageOnBlur(rowIndex: number, col: number): void {
    if (
      !this.editing ||
      this.editing.row !== rowIndex ||
      this.editing.col !== col
    )
      return
    this.commitEditor('none')
  }

  private commitEditor(move: 'down' | 'right' | 'left' | 'none'): void {
    const at = this.editing
    if (!at) return
    const slot = this.slots[at.row]
    const column = this.ctx.columns[at.col]
    // Read before closing: the editor is the only holder of the typed value.
    const value = this.editor?.read()
    this.closeEditor()
    if (slot?.id && column) {
      this.ctx.session.stage(slot.id, slot.row, column.name, value)
      this.repaintCell(at.row, at.col)
      this.refreshBar(at.row)
      this.ctx.onDirtyChange()
    }
    const next = afterCommit(
      { ...this.cellState(), ...at, editing: false },
      move,
    )
    if (next.type === 'move') this.focusCell(next.row, next.col)
  }

  /** Escape: the editor is dropped unread and the cell repaints from the buffer. */
  private cancelEditor(): void {
    const at = this.editing
    if (!at) return
    this.closeEditor()
    this.repaintCell(at.row, at.col)
    this.focusCell(at.row, at.col)
  }

  private closeEditor(): void {
    const at = this.editing
    this.editing = null
    this.editor = null
    if (at) this.slots[at.row]?.cells[at.col]?.classList.remove('editing')
  }

  /** Delete on a selected cell: SQL NULL, not the empty string. */
  private stageNull(): void {
    const slot = this.slots[this.cursor.row]
    const column = this.ctx.columns[this.cursor.col]
    if (!slot?.id || !column) return
    this.ctx.session.stage(slot.id, slot.row, column.name, null)
    this.repaintCell(this.cursor.row, this.cursor.col)
    this.refreshBar(this.cursor.row)
    this.ctx.onDirtyChange()
  }

  // ------------------------------------------------------------- the row bar

  refreshBar(rowIndex: number): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    const changed = slot.id ? this.ctx.session.changedColumns(slot.id) : []
    paintRowBar(slot.bar, changed)
  }

  private saveRow(rowIndex: number): void {
    const slot = this.slots[rowIndex]
    if (slot?.id) this.ctx.onSaveRow(slot.id)
  }

  private revertRow(rowIndex: number): void {
    const slot = this.slots[rowIndex]
    if (!slot?.id) return
    this.ctx.session.drop(slot.id)
    this.repaintRow(rowIndex)
    this.ctx.onDirtyChange()
  }

  repaintRow(rowIndex: number): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    this.ctx.columns.forEach((_column, col) => {
      this.repaintCell(rowIndex, col)
    })
    this.refreshBar(rowIndex)
    slot.bar.message.textContent = ''
  }

  /** Where a save's failure is reported: under the row it belongs to. */
  setRowMessage(rowIndex: number, message: string): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    setRowBarMessage(slot.bar, message)
  }

  setRowBusy(rowIndex: number, busy: boolean): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    setBusy(slot.tr, busy)
    for (const input of slot.tr.querySelectorAll(
      'input,button,select,textarea',
    )) {
      ;(input as HTMLInputElement).disabled = busy
    }
  }

  indexOfRow(id: string): number {
    return this.slots.findIndex(slot => slot?.id === id)
  }

  rowAt(index: number): Record<string, unknown> | undefined {
    return this.slots[index]?.row
  }

  /** The row under the cursor — what a keyboard-only user means by "this row". */
  focusedRow(): Record<string, unknown> | undefined {
    return this.slots[this.cursor.row]?.row
  }

  /** The rows the checkboxes name, as identity objects for a write. */
  selectedKeys(): Record<string, unknown>[] {
    const cols = this.ctx.table.identity.cols
    const keys: Record<string, unknown>[] = []
    for (const slot of this.slots) {
      if (!slot?.id || !this.selected.has(slot.id)) continue
      const key: Record<string, unknown> = {}
      for (const column of cols) key[column] = slot.row[column]
      keys.push(key)
    }
    return keys
  }

  selectedRows(): Record<string, unknown>[] {
    return this.slots
      .filter(slot => slot?.id && this.selected.has(slot.id))
      .map(slot => slot.row)
  }

  private setSelected(id: string | null, on: boolean): void {
    if (!id) return
    if (on) this.selected.add(id)
    else this.selected.delete(id)
    this.ctx.onSelectionChange(this.selected.size)
  }

  private setAllSelected(on: boolean): void {
    for (const slot of this.slots) {
      if (!slot?.id || !slot.check) continue
      slot.check.checked = on
      if (on) this.selected.add(slot.id)
      else this.selected.delete(slot.id)
    }
    this.ctx.onSelectionChange(this.selected.size)
  }
}
