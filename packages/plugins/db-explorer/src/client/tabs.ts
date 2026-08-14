/**
 * Open tables as tabs, with VS Code's preview semantics.
 *
 * **Pure — no DOM.** Every transition is a function from a state to a state, so
 * the rules below are asserted in `tabs.test.ts` rather than inferred from a
 * click handler. `tabstrip.ts` is the view over this.
 *
 * The behaviour is Supabase Studio's, which is VS Code's:
 *
 *  - A **single click** opens a *preview* tab — rendered italic, and **replaced
 *    in place** by the next single click. Browsing twelve tables therefore
 *    leaves one tab open, not twelve, which is the whole point.
 *  - **Double-clicking**, or **editing**, makes it permanent. Investment is what
 *    promotes a tab; merely looking at it is not.
 *  - A table that is already open is *selected* rather than reopened, and its
 *    own view state — page, sort, filters — is left exactly as it was. That is
 *    the property that makes tabs worth having: switching back restores.
 *
 * There is at most one preview tab, which is what makes "replace the preview"
 * unambiguous.
 */

import type { ViewState } from './state'
import { decodeView, defaultView, encodeView } from './state'

export interface Tab {
  view: ViewState
  /** Italic, and replaceable by the next single click. */
  preview: boolean
}

export interface TabsState {
  tabs: Tab[]
  /** Index into `tabs`, or `-1` for the new-tab page when nothing is open. */
  active: number
}

export function createTabs(): TabsState {
  return { tabs: [], active: -1 }
}

export function activeTab(state: TabsState): Tab | null {
  return state.tabs[state.active] ?? null
}

export function activeView(state: TabsState): ViewState | null {
  return activeTab(state)?.view ?? null
}

export function indexOfTable(state: TabsState, table: string): number {
  return state.tabs.findIndex(tab => tab.view.table === table)
}

function previewIndex(state: TabsState): number {
  return state.tabs.findIndex(tab => tab.preview)
}

/**
 * Single click: open as preview.
 *
 * Three cases in order, and the order is the behaviour. An already-open table
 * wins over everything — reopening it would throw away the page and filters the
 * user left it on, which is precisely what tabs exist to preserve.
 */
export function openPreview(state: TabsState, view: ViewState): TabsState {
  const existing = indexOfTable(state, view.table)
  if (existing >= 0) return { ...state, active: existing }

  const slot = previewIndex(state)
  const tab: Tab = { view, preview: true }
  if (slot >= 0) {
    const tabs = [...state.tabs]
    tabs[slot] = tab
    return { tabs, active: slot }
  }
  return { tabs: [...state.tabs, tab], active: state.tabs.length }
}

/**
 * Double click, or any explicit "open and keep": a permanent tab.
 *
 * An already-open preview tab for the same table is promoted where it stands
 * rather than moved, so the strip does not reorder under the cursor that just
 * double-clicked it.
 */
export function openPermanent(state: TabsState, view: ViewState): TabsState {
  const existing = indexOfTable(state, view.table)
  if (existing >= 0) {
    const tabs = [...state.tabs]
    tabs[existing] = { ...tabs[existing]!, preview: false }
    return { tabs, active: existing }
  }

  const slot = previewIndex(state)
  const tab: Tab = { view, preview: false }
  if (slot >= 0) {
    const tabs = [...state.tabs]
    tabs[slot] = tab
    return { tabs, active: slot }
  }
  return { tabs: [...state.tabs, tab], active: state.tabs.length }
}

export function selectTab(state: TabsState, index: number): TabsState {
  if (index < 0 || index >= state.tabs.length) return state
  return { ...state, active: index }
}

/**
 * Close one tab.
 *
 * Closing the active tab activates whatever slid into its slot — the tab to the
 * right — and the last tab when there is nothing to the right. Closing anything
 * left of the active one shifts the active index down so the *same* tab stays
 * selected, which is the bug the naive version has.
 */
export function closeTab(state: TabsState, index: number): TabsState {
  if (index < 0 || index >= state.tabs.length) return state
  const tabs = state.tabs.filter((_tab, at) => at !== index)
  if (!tabs.length) return { tabs, active: -1 }

  let active = state.active
  if (index < state.active) active = state.active - 1
  else if (index === state.active) active = Math.min(index, tabs.length - 1)
  return { tabs, active }
}

/** What a real edit does to a preview tab. Idempotent, and a no-op when none. */
export function promoteActive(state: TabsState): TabsState {
  const tab = activeTab(state)
  if (!tab?.preview) return state
  const tabs = [...state.tabs]
  tabs[state.active] = { ...tab, preview: false }
  return { ...state, tabs }
}

/**
 * A new view for the active tab, keeping its preview flag.
 *
 * Paging and sorting inside a preview tab deliberately do **not** promote it:
 * looking harder at a table is still looking. Only `promoteActive` promotes.
 */
export function replaceActiveView(
  state: TabsState,
  view: ViewState,
): TabsState {
  const tab = activeTab(state)
  if (!tab) return openPermanent(state, view)
  const tabs = [...state.tabs]
  tabs[state.active] = { ...tab, view }
  return { ...state, tabs }
}

/**
 * Drop tabs whose table no longer exists.
 *
 * A link can name anything, and a schema can change between two visits. A tab
 * pointing at a table that is gone would render "Pick a table" forever with no
 * way to tell why.
 */
export function pruneTabs(
  state: TabsState,
  known: ReadonlySet<string>,
): TabsState {
  const keep = state.tabs.filter(tab => known.has(tab.view.table))
  if (keep.length === state.tabs.length) return state
  const wanted = activeTab(state)
  const active = wanted ? keep.indexOf(wanted) : -1
  return { tabs: keep, active: active >= 0 ? active : keep.length - 1 }
}

/**
 * The whole strip in a hash.
 *
 * `x` repeats, one per tab, each holding a whole encoded view — `URLSearchParams`
 * escapes the inner `&` on the way in and unescapes it on the way out, so the
 * nesting needs no encoding of its own. `a` is the active index and `w` the
 * preview one; both are indexes rather than flags because there is at most one
 * of each and an index is shorter than a marker on every tab.
 */
export function encodeTabs(state: TabsState): string {
  const params = new URLSearchParams()
  for (const tab of state.tabs) params.append('x', encodeView(tab.view))
  if (state.active >= 0) params.set('a', String(state.active))
  const preview = previewIndex(state)
  if (preview >= 0) params.set('w', String(preview))
  return params.toString()
}

export function decodeTabs(hash: string): TabsState {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const encoded = params.getAll('x')

  // A pre-tabs link — `#t=parcels&p=2` — is one permanent tab. Those links are
  // in chat logs and bookmarks, and silently rendering nothing for them would
  // be the most visible possible regression.
  if (!encoded.length) {
    const single = decodeView(hash)
    if (!single.table) return createTabs()
    return { tabs: [{ view: single, preview: false }], active: 0 }
  }

  const tabs: Tab[] = encoded.map(part => ({
    view: decodeView(part),
    preview: false,
  }))
  const preview = readIndex(params.get('w'), tabs.length)
  if (preview >= 0) tabs[preview]!.preview = true

  const active = readIndex(params.get('a'), tabs.length)
  return { tabs, active: active >= 0 ? active : tabs.length - 1 }
}

/** An index from a hand-editable URL, or `-1`. Never out of range. */
function readIndex(raw: string | null, length: number): number {
  if (raw === null) return -1
  const value = Number.parseInt(raw, 10)
  return Number.isFinite(value) && value >= 0 && value < length ? value : -1
}

/** A fresh tab for a table, as the sidebar and the relations view make one. */
export function tabView(table: string): ViewState {
  return defaultView(table)
}
