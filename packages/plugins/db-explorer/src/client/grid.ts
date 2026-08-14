/**
 * The editable grid.
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
 * The editing model itself is in `edit-session.ts` and the keyboard model in
 * `cell.ts`, both pure and both tested. What is left here is the part that
 * genuinely needs a DOM: which node holds which value, and where focus is.
 */

import { afterCommit, type CellAction, type CellState, keyOnCell } from './cell'
import { append, box, button, each, el, on, setBusy } from './dom'
import type { EditSession } from './edit-session'
import { rowId } from './edit-session'
import { createEditor, type EditorHandle } from './editors'
import {
  type FkResolver,
  type FkTarget,
  fkForColumn,
  fkKeyOf,
  fkLabel,
} from './fk'
import {
  cellProps,
  type SchemaColumn,
  type SchemaGraph,
  type SchemaTable,
} from './meta'

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
  /** The row a link asked for, highlighted when it is on this page. */
  focus: Record<string, unknown> | null
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
  bar: HTMLTableRowElement
  message: HTMLElement
  count: HTMLElement
  check: HTMLInputElement | null
}

export class Grid {
  readonly node: HTMLElement
  private readonly slots: RowSlot[] = []
  private readonly body: HTMLTableSectionElement
  private cursor = { row: 0, col: 0 }
  private editor: EditorHandle | null = null
  private editing: { row: number; col: number } | null = null
  readonly selected = new Set<string>()

  constructor(private readonly ctx: GridContext) {
    const table = el('table', { class: 'grid' })
    table.appendChild(this.buildHead())
    this.body = el('tbody')
    table.appendChild(this.body)
    each(this.body, ctx.rows, (row, index) => this.buildRow(row, index))
    this.node = box('scroll', table)
    on(this.node, 'keydown', event => this.onKeyDown(event as KeyboardEvent))
    this.highlightFocused()
  }

  // ------------------------------------------------------------------ header

  private buildHead(): HTMLTableSectionElement {
    const head = el('thead')
    const tr = el('tr')
    tr.appendChild(this.buildSelectAll())
    each(tr, this.ctx.columns, column => this.buildHeaderCell(column))
    head.appendChild(tr)
    return head
  }

  /**
   * The leading column exists on every table, editable or not: it carries the
   * row drawer's opener, which a read-only table needs just as much — a
   * forty-column row is unreadable in a grid whether or not it can be changed.
   * The select-all checkbox joins it only when there is something to select
   * *for*.
   */
  private buildSelectAll(): HTMLTableCellElement {
    const th = el('th', { class: 'pick' })
    if (!this.ctx.editable) return th
    const check = el('input', { attrs: { 'aria-label': 'select all rows' } })
    check.type = 'checkbox'
    on(check, 'change', () => this.setAllSelected(check.checked))
    th.appendChild(check)
    return th
  }

  private buildHeaderCell(column: SchemaColumn): HTMLTableCellElement {
    const arrow =
      this.ctx.sortBy === column.name
        ? this.ctx.sortOrder === 'ASC'
          ? ' ↑'
          : ' ↓'
        : ''
    const th = el('th', {
      text: column.name + arrow,
      title: `${column.type}${column.notnull ? ' NOT NULL' : ''}`,
      attrs: { 'data-kind': column.kind },
    })
    if (column.pk) th.classList.add('pk')
    on(th, 'click', () => this.ctx.onSort(column.name))
    return th
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

    const bar = this.buildBar(index)
    const slot: RowSlot = {
      id,
      row,
      tr,
      cells,
      bar: bar.tr,
      message: bar.message,
      count: bar.count,
      check,
    }
    this.slots[index] = slot
    // A fragment so one `each` callback can add two rows: the data row and the
    // save/revert bar that lives under it.
    const fragment = document.createDocumentFragment()
    fragment.append(tr, bar.tr)
    return fragment
  }

  /** Selection checkbox (when editable) and the drawer opener (always). */
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
    td.appendChild(
      button('⋯', () => this.ctx.onOpenRow(row), {
        class: 'btn',
        title: 'open this row',
      }),
    )
    tr.appendChild(td)
    return check
  }

  private buildBar(index: number): {
    tr: HTMLTableRowElement
    message: HTMLElement
    count: HTMLElement
  } {
    const tr = el('tr', { class: 'row-bar-row' })
    const td = el('td')
    td.colSpan = this.ctx.columns.length + 1
    const bar = box('row-bar')
    const count = el('span', { class: 'note' })
    const message = el('span', { class: 'row-error' })
    append(bar, [
      count,
      button('Save', () => this.saveRow(index), { class: 'btn primary' }),
      button('Revert', () => this.revertRow(index), { class: 'btn' }),
      message,
    ])
    td.appendChild(bar)
    tr.appendChild(td)
    return { tr, message, count }
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
    this.paintCell(rowIndex, col, td, row, column)
    return td
  }

  /**
   * Render one cell from the session's current view of it.
   *
   * Called on build, after every stage, and after an editor closes — so a
   * staged value and a saved value take exactly the same path and cannot
   * diverge in how they look.
   */
  private paintCell(
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
    const props = cellProps(value, meta)

    td.replaceChildren()
    td.className = props.className
    if (id && this.ctx.session.isStaged(id, meta.name))
      td.classList.add('staged')
    if (props.title) td.title = props.title
    td.appendChild(this.cellBody(source, meta, value))
  }

  /**
   * A cell's content: a foreign-key button, or text.
   *
   * The button is a real `<button>` rather than a styled span, because it is
   * activated by keyboard and read as an action by a screen reader — a `div`
   * with a click handler is neither.
   */
  private cellBody(
    row: Record<string, unknown>,
    column: SchemaColumn,
    value: unknown,
  ): Node {
    const target = fkForColumn(this.ctx.graph, this.ctx.table.name, column.name)
    const key = target ? fkKeyOf(target, row) : null
    if (!target || !key) {
      return document.createTextNode(cellProps(value, column).text)
    }
    return this.fkButton(target, key, cellProps(value, column).text)
  }

  private fkButton(
    target: FkTarget,
    key: Record<string, unknown>,
    text: string,
  ): HTMLButtonElement {
    const node = button(text, () => this.ctx.onFollowFk(target, key), {
      class: 'fk',
      title: `→ ${target.refTable}`,
    })
    const show = (resolved: Record<string, unknown> | null) => {
      const label = fkLabel(this.ctx.graph, target.refTable, resolved)
      node.title = label
        ? `${target.refTable}: ${label}`
        : `→ ${target.refTable}`
      if (label) node.textContent = `${text} · ${label}`
    }
    const cached = this.ctx.resolver.cached(target.refTable, key)
    if (cached !== undefined) show(cached)

    let disarm: (() => void) | null = null
    on(node, 'pointerenter', () => {
      disarm = this.ctx.resolver.arm(target.refTable, key, show)
    })
    on(node, 'pointerleave', () => {
      disarm?.()
      disarm = null
    })
    return node
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
      this.paintCell(at.row, at.col)
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
    this.paintCell(at.row, at.col)
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
    this.paintCell(this.cursor.row, this.cursor.col)
    this.refreshBar(this.cursor.row)
    this.ctx.onDirtyChange()
  }

  // ------------------------------------------------------------- the row bar

  /** The changed-column count, and whether the bar is shown at all. */
  refreshBar(rowIndex: number): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    const changed = slot.id ? this.ctx.session.changedColumns(slot.id) : []
    slot.bar.classList.toggle('open', changed.length > 0)
    slot.count.textContent = changed.length
      ? `${changed.length} column${changed.length === 1 ? '' : 's'} changed: ${changed.join(', ')}`
      : ''
    if (changed.length) slot.message.textContent = ''
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
      this.paintCell(rowIndex, col)
    })
    this.refreshBar(rowIndex)
    slot.message.textContent = ''
  }

  /** Where a save's failure is reported: under the row it belongs to. */
  setRowMessage(rowIndex: number, message: string): void {
    const slot = this.slots[rowIndex]
    if (!slot) return
    slot.bar.classList.add('open')
    slot.message.textContent = message
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

  /**
   * The row a link named, if it is on this page.
   *
   * `filters` is a substring `LIKE` and cannot name a row (see `api.ts`), so a
   * link carries the identity separately and this is where the two meet. When
   * the row is not here, `focusedMissing()` tells the caller to say so rather
   * than silently highlighting nothing.
   */
  private highlightFocused(): void {
    const wanted = this.ctx.focus
    if (!wanted) return
    const id = rowId(wanted, this.ctx.table.identity.cols)
    if (!id) return
    const index = this.indexOfRow(id)
    if (index < 0) return
    this.slots[index]?.tr.classList.add('focused')
    this.slots[index]?.tr.scrollIntoView({ block: 'center' })
  }

  focusedMissing(): boolean {
    if (!this.ctx.focus) return false
    const id = rowId(this.ctx.focus, this.ctx.table.identity.cols)
    return id === null || this.indexOfRow(id) < 0
  }
}
