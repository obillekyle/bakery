/**
 * Everything that paints a page, and nothing that fetches one.
 *
 * The split is the same rule the grid follows: `client.ts` asks the server and
 * hands the answer here, and here it becomes nodes. Keeping the two apart is
 * what stopped the entry module growing back into the 197-line
 * fetch-and-render `renderTable` it replaced.
 *
 * The painters take callbacks rather than reaching for the entry's state, so
 * the page has no opinion about routing, saving or the drawer — it only knows
 * what to call.
 */

import { type BulkToolbar, bulkToolbar } from './bulk'
import { openImport } from './csv'
import { append, box, button, each, el, on } from './dom'
import type { EditSession, UndoStack } from './edit-session'
import type { FkResolver, FkTarget } from './fk'
import { Grid } from './grid'
import type { SchemaColumn, SchemaTable, TablePage } from './meta'
import {
  type AppState,
  editableTable,
  PAGE_SIZE,
  readOnlyReason,
  type ViewState,
} from './state'

export interface PageHooks {
  goto: (view: ViewState) => void
  saveRow: (table: SchemaTable, id: string) => void
  openRow: (
    table: SchemaTable,
    columns: SchemaColumn[],
    editable: boolean,
    row: Record<string, unknown>,
  ) => void
  followFk: (target: FkTarget, key: Record<string, unknown>) => void
  reload: () => Promise<void>
  /** Where a breadcrumb click rewinds the trail to. */
  rewind: (depth: number) => void
}

export class Page {
  grid: Grid | null = null
  private toolbar: BulkToolbar | null = null
  private badge: HTMLElement | null = null

  constructor(
    private readonly state: AppState,
    private readonly session: EditSession,
    private readonly resolver: FkResolver,
    private readonly undo: UndoStack,
    private readonly hooks: PageHooks,
  ) {}

  // ------------------------------------------------------------------- shell

  renderShell(app: HTMLElement): void {
    app.replaceChildren()
    const side = el('nav', { class: 'side' })
    side.appendChild(el('h1', { class: 'brand', text: 'db explorer' }))
    side.appendChild(
      el('p', {
        class: 'note',
        text:
          this.state.report?.access === 'write' ? 'read · write' : 'read-only',
      }),
    )
    each(side, this.state.report?.tables ?? [], table =>
      this.tableButton(table),
    )

    const main = el('main', { class: 'main', id: 'main' })
    main.appendChild(el('p', { class: 'note', text: 'Pick a table.' }))
    app.append(side, main)
  }

  private tableButton(table: SchemaTable): HTMLElement {
    const node = button(
      table.name,
      () => this.hooks.goto(newView(table.name)),
      {
        class: 'table-btn',
      },
    )
    if (table.name === this.state.view.table) node.classList.add('active')
    if (!table.writable) {
      // The padlock is on the *table list*, so a read-only table is visible as
      // such before it is opened rather than at the first double-click.
      node.appendChild(el('span', { class: 'ro', text: '🔒' }))
      node.title = table.reason ?? 'read-only'
    }
    return node
  }

  refreshSidebar(app: HTMLElement): void {
    for (const node of app.querySelectorAll('.table-btn')) {
      // The label is the button's first text node; a padlock `<span>` follows
      // it on a read-only table, so `textContent` alone would not match.
      const name = node.firstChild?.textContent ?? node.textContent
      node.classList.toggle('active', name === this.state.view.table)
    }
  }

  // -------------------------------------------------------------------- page

  paint(main: HTMLElement, table: SchemaTable, data: TablePage): void {
    const editable = editableTable(this.state, table)
    const columns = table.columns
    main.replaceChildren()

    append(main, [
      this.breadcrumbs(),
      this.header(table, data),
      editable ? null : this.readOnlyBanner(table),
      this.filterBar(columns),
    ])

    this.toolbar = this.buildToolbar(table, columns, editable)
    main.appendChild(this.toolbar.node)

    this.grid = this.buildGrid(table, columns, editable, data)
    main.appendChild(this.grid.node)

    append(main, [
      this.grid.focusedMissing() ? missingFocusNote() : null,
      this.pager(data),
      this.rowActions(table, columns, editable),
    ])
    this.paintDirty()
  }

  private buildToolbar(
    table: SchemaTable,
    columns: SchemaColumn[],
    editable: boolean,
  ): BulkToolbar {
    return bulkToolbar({
      table,
      columns,
      editable,
      selectedKeys: () => this.grid?.selectedKeys() ?? [],
      selectedRows: () => this.grid?.selectedRows() ?? [],
      reload: this.hooks.reload,
      undo: this.undo,
      openImport: () =>
        openImport({ table, columns, reload: this.hooks.reload }),
    })
  }

  private buildGrid(
    table: SchemaTable,
    columns: SchemaColumn[],
    editable: boolean,
    data: TablePage,
  ): Grid {
    const view = this.state.view
    return new Grid({
      table,
      columns,
      rows: data.rows ?? [],
      editable,
      graph: this.state.graph,
      session: this.session,
      resolver: this.resolver,
      sortBy: view.sortBy,
      sortOrder: view.sortOrder,
      focus: view.focus,
      onSort: column =>
        this.hooks.goto({
          ...view,
          sortBy: column,
          sortOrder: flip(view, column),
          page: 1,
        }),
      onSaveRow: id => this.hooks.saveRow(table, id),
      onOpenRow: row => this.hooks.openRow(table, columns, editable, row),
      onFollowFk: this.hooks.followFk,
      onSelectionChange: count => this.toolbar?.setCount(count),
      onDirtyChange: () => this.paintDirty(),
    })
  }

  private header(table: SchemaTable, data: TablePage): HTMLElement {
    const head = el('header', { class: 'table-head' })
    const page = this.state.view.page
    head.appendChild(el('h2', { text: table.name }))
    head.appendChild(
      el('span', {
        class: 'note',
        text:
          data.totalRows !== undefined
            ? `${data.totalRows} rows · page ${page}${data.totalPages ? ` / ${data.totalPages}` : ''}`
            : `page ${page}`,
      }),
    )
    this.badge = el('span', { class: 'badge dirty' })
    head.appendChild(this.badge)
    return head
  }

  /** The unsaved-rows badge. Read by the unload guard's user, not by it. */
  paintDirty(): void {
    const count = this.session.dirtyRows()
    if (!this.badge) return
    this.badge.textContent = count ? `${count} unsaved` : ''
    this.badge.style.display = count ? '' : 'none'
  }

  private readOnlyBanner(table: SchemaTable): HTMLElement {
    return el('p', {
      class: 'banner warn',
      text: `read-only — ${readOnlyReason(this.state, table)}`,
    })
  }

  /**
   * Per-column filters, labelled as the substring match they are.
   *
   * `buildFilterSort` in the ORM's base adapter emits `col LIKE '%value%'`.
   * Calling that "filter" without saying so is how someone concludes a row is
   * missing when it is merely not the only match.
   */
  private filterBar(columns: SchemaColumn[]): HTMLElement {
    const bar = box('filters')
    each(bar, columns, column => this.filterInput(column))
    return bar
  }

  private filterInput(column: SchemaColumn): HTMLElement {
    const view = this.state.view
    const input = el('input', {
      title: 'substring match',
      attrs: {
        'aria-label': `filter ${column.name}`,
        placeholder: column.name,
      },
    })
    input.value = view.filters[column.name] ?? ''
    on(input, 'change', () => {
      const filters = { ...view.filters }
      if (input.value) filters[column.name] = input.value
      else delete filters[column.name]
      this.hooks.goto({ ...view, filters, page: 1 })
    })
    return input
  }

  private pager(data: TablePage): HTMLElement {
    const view = this.state.view
    const bar = el('footer', { class: 'pager' })
    const previous = button(
      '← prev',
      () => this.hooks.goto({ ...view, page: view.page - 1 }),
      { class: 'btn' },
    )
    previous.disabled = view.page <= 1

    const next = button(
      'next →',
      () => this.hooks.goto({ ...view, page: view.page + 1 }),
      { class: 'btn' },
    )
    next.disabled =
      data.totalPages !== undefined
        ? view.page >= data.totalPages
        : (data.rows?.length ?? 0) < PAGE_SIZE

    append(bar, [previous, next, this.undoButton()])
    return bar
  }

  private undoButton(): HTMLElement | null {
    const entry = this.undo.peek()
    if (!entry) return null
    return button(
      `Undo ${entry.label}`,
      () => {
        this.undo.pop()
        void entry.undo()
      },
      { class: 'btn' },
    )
  }

  private rowActions(
    table: SchemaTable,
    columns: SchemaColumn[],
    editable: boolean,
  ): HTMLElement {
    const bar = box('toolbar')
    const open = button(
      'Open row',
      () => {
        const row = this.grid?.focusedRow()
        if (row) this.hooks.openRow(table, columns, editable, row)
      },
      { class: 'btn', title: 'the row under the cursor' },
    )
    const hint = el('span', {
      class: 'note',
      text: 'Enter edits · Esc reverts · Tab commits right · Delete stages NULL',
    })
    append(bar, [open, hint])
    return bar
  }

  /** Where a foreign-key jump came from, so Back returns rather than resets. */
  private breadcrumbs(): HTMLElement | null {
    if (!this.state.trail.length) return null
    const bar = box('crumbs')
    bar.appendChild(el('span', { class: 'note', text: 'from' }))
    each(bar, this.state.trail, (view, depth) =>
      button(view.table, () => this.hooks.rewind(depth), { class: 'btn' }),
    )
    return bar
  }
}

function flip(view: ViewState, column: string): 'ASC' | 'DESC' {
  const same = view.sortBy === column
  return same && view.sortOrder === 'ASC' ? 'DESC' : 'ASC'
}

function missingFocusNote(): HTMLElement {
  return el('p', {
    class: 'note',
    text:
      'the linked row is not on this page — the filter is a substring match, ' +
      'not an exact one',
  })
}

/** A fresh view of a table. Local so `page.ts` does not import routing. */
function newView(table: string): ViewState {
  return {
    table,
    page: 1,
    sortBy: null,
    sortOrder: 'ASC',
    filters: {},
    focus: null,
  }
}
