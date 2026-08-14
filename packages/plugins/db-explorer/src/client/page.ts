/**
 * Everything that paints a page, and nothing that fetches one.
 *
 * The split is the same rule the grid follows: `client.ts` asks the server and
 * hands the answer here, and here it becomes nodes. Keeping the two apart is
 * what stopped the entry module growing back into the 197-line
 * fetch-and-render `renderTable` it replaced.
 *
 * The shape is now three regions rather than two — sidebar, then a column
 * holding the tab strip, the active view and the status bar. The sidebar and
 * the status bar outlive a tab switch; only `#main` is replaced. The painters
 * take callbacks rather than reaching for the entry's state, so the page has no
 * opinion about routing, saving or the panel.
 */

import type { Filter } from '../shared/filters'
import { type BulkToolbar, bulkToolbar } from './bulk'
import { openImport } from './csv'
import { append, box, button, el } from './dom'
import type { EditSession, UndoStack } from './edit-session'
import { filterBar } from './filter-builder'
import type { FkResolver, FkTarget } from './fk'
import { Grid } from './grid'
import type { SchemaColumn, SchemaTable, TablePage } from './meta'
import { renderRelations } from './relations'
import {
  type AppState,
  editableTable,
  PAGE_SIZE,
  readOnlyReason,
  type TableView,
  type ViewState,
} from './state'
import { StatusBar } from './statusbar'
import { renderStructure } from './structure'

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
  /** Open another table in a tab, filtered. */
  openTable: (table: string, filters: Filter[]) => void
  /**
   * A cell was staged or reverted.
   *
   * The entry module uses it to promote a preview tab: nobody wants the tab
   * they just typed into replaced by the next single click in the sidebar.
   */
  onEdit: () => void
  /** Where a breadcrumb click rewinds the trail to. */
  rewind: (depth: number) => void
}

export class Page {
  grid: Grid | null = null
  readonly status = new StatusBar()
  private toolbar: BulkToolbar | null = null
  private lastMs: number | null = null

  constructor(
    private readonly state: AppState,
    private readonly session: EditSession,
    private readonly resolver: FkResolver,
    private readonly undo: UndoStack,
    private readonly hooks: PageHooks,
  ) {}

  // -------------------------------------------------------------------- data

  /**
   * The Data view: filters, the bulk toolbar, the grid, the pager.
   *
   * `data` is the page the server just returned and `ms` is what it said it
   * cost — the status bar's timing is the envelope's own number rather than a
   * round trip timed here, so a slow filter is attributable.
   */
  paint(
    main: HTMLElement,
    view: ViewState,
    table: SchemaTable,
    data: TablePage,
    ms: number,
  ): void {
    this.lastMs = ms
    const editable = editableTable(this.state, table)
    const columns = table.columns
    main.replaceChildren()

    append(main, [
      this.breadcrumbs(),
      editable ? null : this.readOnlyBanner(table),
      this.filters(view, columns),
    ])

    this.toolbar = this.buildToolbar(table, columns, editable)
    main.appendChild(this.toolbar.node)

    this.grid = this.buildGrid(view, table, columns, editable, data)
    main.appendChild(this.grid.node)

    append(main, [
      this.pager(view, data),
      this.rowActions(table, columns, editable),
    ])
    this.paintStatus(view, data)
  }

  /** Structure and Relations: no grid, no fetch, no pager. */
  paintMeta(main: HTMLElement, view: ViewState, table: SchemaTable): void {
    this.grid = null
    this.toolbar = null
    main.replaceChildren()
    append(main, [this.breadcrumbs()])

    main.appendChild(
      view.view === 'structure'
        ? renderStructure({
            table,
            editable: editableTable(this.state, table),
            reason: readOnlyReason(this.state, table),
          })
        : renderRelations({
            table: table.name,
            graph: this.state.graph,
            onOpen: this.hooks.openTable,
          }),
    )
    this.paintStatus(view, null)
  }

  /** Nothing is open, or the table went missing. */
  paintEmpty(main: HTMLElement, node: HTMLElement): void {
    this.grid = null
    this.toolbar = null
    this.lastMs = null
    main.replaceChildren(node)
    this.status.paint({
      table: null,
      page: 1,
      ms: null,
      access: this.state.report?.access ?? false,
      dirtyRows: this.session.dirtyRows(),
      filterCount: 0,
    })
  }

  // ------------------------------------------------------------------ status

  private paintStatus(view: ViewState, data: TablePage | null): void {
    this.status.paint({
      table: view.table,
      totalRows: data?.totalRows,
      page: view.page,
      totalPages: data?.totalPages,
      // Structure and Relations render from the schema the client already
      // holds, so there is no timing to report and none is invented.
      ms: data ? this.lastMs : null,
      access: this.state.report?.access ?? false,
      dirtyRows: this.session.dirtyRows(),
      filterCount: view.filters.length,
    })
  }

  /** Re-read the dirty count without repainting anything else. */
  paintDirty(): void {
    const facts = this.status
    facts.bumpDirty(this.session.dirtyRows())
  }

  // ------------------------------------------------------------------ pieces

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
    view: ViewState,
    table: SchemaTable,
    columns: SchemaColumn[],
    editable: boolean,
    data: TablePage,
  ): Grid {
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
      onDirtyChange: () => {
        this.paintDirty()
        this.hooks.onEdit()
      },
    })
  }

  private readOnlyBanner(table: SchemaTable): HTMLElement {
    return el('p', {
      class: 'banner warn',
      text: `read-only — ${readOnlyReason(this.state, table)}`,
    })
  }

  /**
   * The filter builder.
   *
   * A chip per condition — column, operator, value, remove — where there used
   * to be one text box per column that could only ever mean "contains". Any
   * change resets to page 1, because a filtered result has different pages and
   * staying on page 7 of a set that now has two is a blank screen.
   */
  private filters(view: ViewState, columns: SchemaColumn[]): HTMLElement {
    return filterBar({
      columns,
      filters: view.filters,
      onChange: filters => this.hooks.goto({ ...view, filters, page: 1 }),
    })
  }

  private pager(view: ViewState, data: TablePage): HTMLElement {
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
    this.state.trail.forEach((view, depth) => {
      bar.appendChild(
        button(view.table, () => this.hooks.rewind(depth), { class: 'btn' }),
      )
    })
    return bar
  }
}

function flip(view: ViewState, column: string): 'ASC' | 'DESC' {
  const same = view.sortBy === column
  return same && view.sortOrder === 'ASC' ? 'DESC' : 'ASC'
}

export type { TableView }
