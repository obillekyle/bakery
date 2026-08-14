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
 * What is deliberately *not* here, and is not anywhere: a SQL console, an ER
 * diagram, and grid virtualisation. The first is refused by the plugin's
 * contract — no raw SQL, structurally — and the other two are not what a row
 * editor is for.
 */

import { adoptUrlKey, fetchGraph, fetchPage, fetchSchema } from './client/api'
import { confirmChoice, notify } from './client/confirm'
import { el } from './client/dom'
import { openDrawer } from './client/drawer'
import { EditSession, UndoStack } from './client/edit-session'
import { FkResolver, type FkTarget } from './client/fk'
import type { SchemaColumn, SchemaTable, TablePage } from './client/meta'
import { Page } from './client/page'
import { saveRow } from './client/save'
import {
  type AppState,
  createState,
  decodeView,
  defaultView,
  encodeView,
  tableOf,
  type ViewState,
} from './client/state'

const app = document.getElementById('app')!

const state: AppState = createState()
const session = new EditSession()
const resolver = new FkResolver()
const undoStack = new UndoStack(20)

/** Set while `writeHash` writes, so the `hashchange` listener ignores itself. */
let selfNavigation = false

const page = new Page(state, session, resolver, undoStack, {
  goto: view => void goto(view),
  saveRow: (table, id) =>
    void saveRow(table, id, {
      session,
      surface: () => page.grid,
      reload: renderMain,
      onDirtyChange: () => page.paintDirty(),
    }),
  openRow: openRowDrawer,
  followFk: (target, key) => void followFk(target, key),
  reload: () => renderMain(),
  rewind: depth => {
    state.trail = state.trail.slice(0, depth)
    void goto(state.trail[depth] ?? defaultView(state.view.table))
  },
})

// ------------------------------------------------------------------- routing

function writeHash(): void {
  selfNavigation = true
  location.hash = encodeView(state.view)
  // `hashchange` fires as a task, so the flag has to survive at least until
  // the next one — a microtask would clear it before the listener ran.
  setTimeout(() => {
    selfNavigation = false
  }, 0)
}

/**
 * Move to a view, asking first if anything is unsaved.
 *
 * The navigation half of the unload guard: losing typed values to a mis-click
 * on a table name is the same loss as losing them to a closed tab, and only one
 * of the two was ever guarded by the browser.
 */
async function goto(view: ViewState): Promise<void> {
  if (session.dirtyRows() > 0) {
    const ok = await confirmChoice({
      verb: 'discard',
      count: session.dirtyRows(),
      table: state.view.table || '—',
      detail: 'unsaved edits will be thrown away',
    })
    if (!ok) return
  }
  session.clear()
  state.view = view
  writeHash()
  await renderMain()
}

/** Fetch, then render — the two never live in one function. */
async function renderMain(): Promise<void> {
  const main = document.getElementById('main')!
  const table = tableOf(state, state.view.table)
  if (!table) {
    main.replaceChildren(el('p', { class: 'note', text: 'Pick a table.' }))
    return
  }

  main.replaceChildren(
    el('p', { class: 'note', text: `loading ${table.name}…` }),
  )
  let data: TablePage
  try {
    data = await fetchPage(state.view)
  } catch (error) {
    main.replaceChildren(el('p', { class: 'error', text: messageOf(error) }))
    return
  }
  page.paint(main, table, data)
  page.refreshSidebar(app)
}

// ---------------------------------------------------------- drawer and links

function openRowDrawer(
  table: SchemaTable,
  columns: SchemaColumn[],
  editable: boolean,
  row: Record<string, unknown>,
): void {
  const handle = openDrawer({
    table,
    columns,
    row,
    editable,
    graph: state.graph,
    session,
    onSave: id => {
      handle.close()
      void saveRow(table, id, {
        session,
        surface: () => page.grid,
        reload: renderMain,
        onDirtyChange: () => page.paintDirty(),
      })
    },
    onDirtyChange: () => page.paintDirty(),
    onNavigate: (name, filters) => void goto({ ...defaultView(name), filters }),
  })
}

/**
 * Follow a foreign key.
 *
 * The filter narrows the page and `focus` names the row, because the only
 * filter the endpoint offers is a substring `LIKE` — `1` also matches `11`, so
 * a filter alone cannot say "this row". The current view is pushed first, so
 * Back returns to where the reference was followed from.
 */
async function followFk(
  target: FkTarget,
  key: Record<string, unknown>,
): Promise<void> {
  state.trail.push(state.view)
  const filters: Record<string, string> = {}
  for (const [column, value] of Object.entries(key)) {
    filters[column] = String(value)
  }
  await goto({ ...defaultView(target.refTable), filters, focus: key })
}

// ------------------------------------------------------------------ plumbing

function messageOf(error: unknown): string {
  return (error as Error)?.message ?? String(error)
}

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

  state.view = decodeView(location.hash)
  page.renderShell(app)
  await renderMain()

  window.addEventListener('beforeunload', guardUnload)
  window.addEventListener('hashchange', () => {
    if (selfNavigation) return
    void goto(decodeView(location.hash))
  })
}

void boot().catch(error => {
  notify(messageOf(error), 'error')
})
