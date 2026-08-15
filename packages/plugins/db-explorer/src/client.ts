/**
 * The explorer's browser entry: boot, then wiring. Nothing else.
 *
 * This file used to be the whole client — 197 lines, one `renderTable` that
 * fetched, built a header, built a body and built a pager, and scored **34**
 * against biome's ceiling of 25. Growing that into a data editor would have
 * meant growing that one function, so the shape changed first. The pieces live
 * under `client/`, each obeying two mechanical rules — **no function both
 * fetches and renders**, and **every loop body is a named function** — and what
 * is left here is the composition: state, routing, and which callback goes
 * where.
 *
 * The layout is the one a database client is expected to have: a table list, a
 * strip of table tabs with VS Code preview semantics, Data / Structure /
 * Relations under it — **one level of nesting and no more** — and a status bar.
 * Tab state lives in `client/tabs.ts` and is pure; this module owns the hash.
 *
 * What is deliberately *not* here, and is not anywhere: a SQL console, an ER
 * diagram, and grid virtualisation. The first is refused by the plugin's
 * contract — no raw SQL, structurally — and the other two are not what a row
 * editor is for.
 */

import {
  adoptUrlKey,
  fetchGraph,
  fetchPage,
  fetchSchema,
  messageOf,
} from './client/api'
import { confirmChoice, notify } from './client/confirm'
import { el } from './client/dom'
import { EditSession, UndoStack } from './client/edit-session'
import { equalityFilters } from './client/filter-builder'
import { FkResolver, type FkTarget } from './client/fk'
import type { SchemaColumn, SchemaTable } from './client/meta'
import { Page } from './client/page'
import { openPanel } from './client/panel'
import { saveRow } from './client/save'
import { renderSidebar } from './client/sidebar'
import {
  type AppState,
  createState,
  defaultView,
  isSystemTable,
  type TableView,
  tableOf,
  type ViewState,
} from './client/state'
import {
  activeTab,
  activeView,
  closeTab,
  createTabs,
  decodeTabs,
  encodeTabs,
  openPermanent,
  openPreview,
  promoteActive,
  pruneTabs,
  replaceActiveView,
  selectTab,
  type TabsState,
} from './client/tabs'
import {
  renderNewTabPage,
  renderTabStrip,
  renderViewTabs,
} from './client/tabstrip'
import type { Filter } from './shared/filters'

const app = document.getElementById('app')!

const state: AppState = createState()
const session = new EditSession()
const resolver = new FkResolver()
const undoStack = new UndoStack(20)

let tabs: TabsState = createTabs()

/** Set while `writeHash` writes, so the `hashchange` listener ignores itself. */
let selfNavigation = false

const page = new Page(state, session, resolver, undoStack, {
  goto: view => void goto(view),
  saveRow: (table, id) => void save(table, id),
  openRow: openRowPanel,
  followFk: (target, key) => void followFk(target, key),
  reload: () => renderMain(),
  openTable: (table, filters) => void openTable(table, filters),
  onEdit: () => {
    if (!activeTab(tabs)?.preview) return
    tabs = promoteActive(tabs)
    writeHash()
    renderChrome()
  },
  rewind: depth => {
    state.trail = state.trail.slice(0, depth)
    void goto(state.trail[depth] ?? defaultView(currentTable()))
  },
})

function currentTable(): string {
  return activeView(tabs)?.table ?? ''
}

function save(table: SchemaTable, id: string): void {
  void saveRow(table, id, {
    session,
    surface: () => page.grid,
    reload: renderMain,
    onDirtyChange: () => page.paintDirty(),
  })
}

// ------------------------------------------------------------------- routing

function writeHash(): void {
  selfNavigation = true
  location.hash = encodeTabs(tabs)
  // `hashchange` fires as a task, so the flag has to survive at least until
  // the next one — a microtask would clear it before the listener ran.
  setTimeout(() => {
    selfNavigation = false
  }, 0)
}

/**
 * Ask before losing typed values.
 *
 * The navigation half of the unload guard: losing typed values to a mis-click
 * on a table name is the same loss as losing them to a closed tab, and only one
 * of the two was ever guarded by the browser.
 */
async function confirmDiscard(): Promise<boolean> {
  if (session.dirtyRows() === 0) return true
  const ok = await confirmChoice({
    verb: 'discard',
    count: session.dirtyRows(),
    table: currentTable() || '—',
    detail: 'unsaved edits will be thrown away',
  })
  if (ok) session.clear()
  return ok
}

/** Move the active tab to a new view of the same table. */
async function goto(view: ViewState): Promise<void> {
  if (!(await confirmDiscard())) return
  tabs = replaceActiveView(tabs, view)
  writeHash()
  await renderMain()
}

/** Switch which tab is showing. Each tab keeps its own page, sort and filters. */
async function select(index: number): Promise<void> {
  if (index === tabs.active) return
  if (!(await confirmDiscard())) return
  tabs = selectTab(tabs, index)
  writeHash()
  await renderAll()
}

/** Single click in the sidebar: a replaceable preview tab. */
async function preview(table: string): Promise<void> {
  if (!(await confirmDiscard())) return
  tabs = openPreview(tabs, defaultView(table))
  writeHash()
  await renderAll()
}

/** Double click, or a link from Relations: a tab that stays. */
async function openTable(table: string, filters: Filter[] = []): Promise<void> {
  if (!(await confirmDiscard())) return
  tabs = openPermanent(tabs, { ...defaultView(table), filters })
  // A link that carries filters is a deliberate destination, so it replaces
  // whatever the tab held rather than restoring the tab's old view.
  if (filters.length) {
    tabs = replaceActiveView(tabs, { ...defaultView(table), filters })
  }
  writeHash()
  await renderAll()
}

async function close(index: number): Promise<void> {
  if (index === tabs.active && !(await confirmDiscard())) return
  tabs = closeTab(tabs, index)
  writeHash()
  await renderAll()
}

function switchView(view: TableView): void {
  const current = activeView(tabs)
  if (!current) return
  void goto({ ...current, view })
}

// ------------------------------------------------------------------ painting

/**
 * The four regions, built **once**.
 *
 * The slots matter: `renderChrome` repaints the sidebar and the strip in
 * place, and `#main` is not one of them. Rebuilding the whole shell on every
 * tab-strip change would tear down the grid — including any editor open in it
 * and the focus inside that editor — every time a staged edit promoted a
 * preview tab, which is precisely when it must not.
 */
const sideSlot = el('div', { class: 'side-slot' })
const stripSlot = el('div', { class: 'strip-slot' })
const mainSlot = el('main', { class: 'main', id: 'main' })

function renderShell(): void {
  const column = el('div', { class: 'column' })
  column.append(stripSlot, mainSlot, page.status.node)
  app.replaceChildren(sideSlot, column)
}

/** Sidebar and tab strip. Repainted whenever the *set* of tabs changes. */
function renderChrome(): void {
  sideSlot.replaceChildren(
    renderSidebar({
      tables: state.report?.tables ?? [],
      showSystem: state.showSystem,
      activeTable: activeView(tabs)?.table ?? null,
      onPreview: table => void preview(table),
      onOpen: table => void openTable(table),
      onToggleSystem: show => {
        state.showSystem = show
        renderChrome()
      },
    }),
  )

  const strip = renderTabStrip({
    tabs,
    onSelect: index => void select(index),
    onPromote: index => {
      tabs = selectTab(tabs, index)
      tabs = promoteActive(tabs)
      writeHash()
      renderChrome()
    },
    onClose: index => void close(index),
    onNew: () => {
      tabs = { ...tabs, active: -1 }
      writeHash()
      void renderAll()
    },
  })

  const current = activeView(tabs)
  stripSlot.replaceChildren(strip)
  if (current) {
    stripSlot.appendChild(
      renderViewTabs({ current: current.view, onSelect: switchView }),
    )
  }
}

async function renderAll(): Promise<void> {
  renderChrome()
  await renderMain()
}

/** Fetch, then render — the two never live in one function. */
async function renderMain(): Promise<void> {
  const main = mainSlot
  const view = activeView(tabs)
  if (!view) {
    page.paintEmpty(main, renderNewTabPage())
    return
  }

  const table = tableOf(state, view.table)
  if (!table) {
    page.paintEmpty(
      main,
      el('p', { class: 'note', text: `${view.table} is not in this schema.` }),
    )
    return
  }

  // Structure and Relations render from the schema report the client already
  // holds — no request, so no loading state and no failure path.
  if (view.view !== 'data') {
    page.paintMeta(main, view, table)
    return
  }

  main.replaceChildren(
    el('p', { class: 'note', text: `loading ${table.name}…` }),
  )
  try {
    const answer = await fetchPage(view)
    page.paint(main, view, table, answer.data, answer.ms)
  } catch (error) {
    main.replaceChildren(el('p', { class: 'error', text: messageOf(error) }))
  }
}

// ----------------------------------------------------------- panel and links

function openRowPanel(
  table: SchemaTable,
  columns: SchemaColumn[],
  editable: boolean,
  row: Record<string, unknown>,
): void {
  const handle = openPanel({
    table,
    columns,
    row,
    editable,
    graph: state.graph,
    session,
    onSave: id => {
      handle.close()
      save(table, id)
    },
    // A real edit is what makes a preview tab permanent — VS Code's rule, and
    // the one that matters: nobody wants the tab they just typed into replaced
    // by the next single click in the sidebar.
    onDirtyChange: () => {
      tabs = promoteActive(tabs)
      page.paintDirty()
      renderChrome()
    },
    onNavigate: (name, filters) => void openTable(name, filters),
  })
}

/**
 * Follow a foreign key.
 *
 * One `eq` filter per referenced column, which *is* the row identity — so the
 * destination page holds exactly the referenced row. This used to need a
 * second mechanism: `filters` was a substring `LIKE`, `id=1` also matched `11`,
 * so a link carried a separate `focus` identity and the grid highlighted it.
 * `eq` removed the need and `focus` went with it.
 *
 * The current view is pushed first, so Back returns to where the reference was
 * followed from — the breadcrumb, which stays.
 */
async function followFk(
  target: FkTarget,
  key: Record<string, unknown>,
): Promise<void> {
  const current = activeView(tabs)
  if (current) state.trail.push(current)
  await openTable(target.refTable, equalityFilters(key))
}

// ------------------------------------------------------------------ plumbing

/**
 * The unload guard.
 *
 * `preventDefault` is the modern spelling and `returnValue` is what Safari
 * still reads. Both, because losing an edit to a closed tab is the failure this
 * exists for and the second line costs a line.
 */
function guardUnload(event: BeforeUnloadEvent): void {
  if (session.dirtyRows() === 0) return
  event.preventDefault()
  event.returnValue = ''
}

async function boot(): Promise<void> {
  adoptUrlKey()
  try {
    // `{access, tables}`: the client has to know its posture *before* it
    // renders, so it never draws an edit affordance it cannot honour.
    state.report = await fetchSchema()
  } catch (error) {
    app.replaceChildren(el('p', { class: 'error', text: messageOf(error) }))
    return
  }

  // The graph is decoration — a schema with no declared foreign keys is
  // ordinary, and a failure here must not cost anyone the grid.
  state.graph = await fetchGraph().catch(() => null)

  // A hash can name a table that has since been dropped; pruning here means
  // the strip never carries a tab that can only ever render an error.
  const known = new Set((state.report.tables ?? []).map(table => table.name))
  tabs = pruneTabs(decodeTabs(location.hash), known)

  // A system table reached by link opens with the sidebar toggle already on,
  // so the tab it lands in is visible in the list beside it rather than
  // appearing to have come from nowhere.
  if (tabs.tabs.some(tab => isSystemTable(tab.view.table))) {
    state.showSystem = true
  }

  renderShell()
  await renderAll()

  window.addEventListener('beforeunload', guardUnload)
  window.addEventListener('hashchange', () => {
    if (selfNavigation) return
    tabs = pruneTabs(decodeTabs(location.hash), known)
    void renderAll()
  })
}

void boot().catch(error => {
  notify(messageOf(error), 'error')
})
