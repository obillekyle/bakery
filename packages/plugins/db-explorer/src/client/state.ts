/**
 * What the explorer is looking at, and how that fits in a URL.
 *
 * **Pure.** `encodeView`/`decodeView` are a round trip over a string and are
 * tested as one. The store below is a plain mutable object with no DOM in it;
 * the hash is written by the entry module, which is the only place that knows
 * about `location`.
 *
 * The view lives in the **hash** rather than the query string on purpose. The
 * explorer is reached with `?db-key=…` on a first visit, the client scrubs that
 * parameter out of the URL immediately, and a view state sharing the query
 * string would be scrubbed along with it — or worse, would have to be
 * reconstructed by an edit to the same `URLSearchParams` the credential was
 * just removed from. A hash also never reaches the server, which is the right
 * place for "which row am I on".
 */

import type { SchemaGraph, SchemaReport, SchemaTable } from './meta'

export const PAGE_SIZE = 50

export interface ViewState {
  table: string
  page: number
  sortBy: string | null
  sortOrder: 'ASC' | 'DESC'
  /** Column → substring. See the note on `filters` in `api.ts`. */
  filters: Record<string, string>
  /**
   * The identity of a row to scroll to and highlight, so a link can name a row
   * rather than a page. `null` when the link is only about a page.
   */
  focus: Record<string, unknown> | null
}

export function defaultView(table = ''): ViewState {
  return {
    table,
    page: 1,
    sortBy: null,
    sortOrder: 'ASC',
    filters: {},
    focus: null,
  }
}

/**
 * `t` table, `p` page, `s` sort column, `o` order, `f` filters, `r` row.
 *
 * Short keys because the focus of a composite key is already JSON in a URL and
 * the whole thing has to stay something a person can paste into chat. Defaults
 * are omitted rather than written, so the common case is `#t=parcels`.
 */
export function encodeView(view: ViewState): string {
  const params = new URLSearchParams()
  if (view.table) params.set('t', view.table)
  if (view.page > 1) params.set('p', String(view.page))
  if (view.sortBy) {
    params.set('s', view.sortBy)
    if (view.sortOrder === 'DESC') params.set('o', 'DESC')
  }
  if (Object.keys(view.filters).length) {
    params.set('f', JSON.stringify(view.filters))
  }
  if (view.focus) params.set('r', JSON.stringify(view.focus))
  return params.toString()
}

export function decodeView(hash: string): ViewState {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const view = defaultView(params.get('t') ?? '')
  const page = Number.parseInt(params.get('p') ?? '1', 10)
  view.page = Number.isFinite(page) && page > 0 ? page : 1
  view.sortBy = params.get('s')
  view.sortOrder = params.get('o') === 'DESC' ? 'DESC' : 'ASC'
  view.filters = readRecord(params.get('f'))
  view.focus = readObject(params.get('r'))
  return view
}

/**
 * A JSON object out of a URL, or nothing.
 *
 * Nothing here is trusted: the hash is user-supplied, an array or a string
 * would break every consumer that iterates it, and a parse failure is a
 * mangled link rather than an error worth showing.
 */
function readObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    // A truncated or hand-edited link. Falling back to "no focus" renders the
    // page the link asked for, which is strictly better than an error page.
    return null
  }
}

function readRecord(raw: string | null): Record<string, string> {
  const object = readObject(raw)
  if (!object) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** Everything the running client holds. One object, mutated in place. */
export interface AppState {
  report: SchemaReport | null
  graph: SchemaGraph | null
  view: ViewState
  /** Views to return to, pushed by a foreign-key jump. */
  trail: ViewState[]
}

export function createState(): AppState {
  return { report: null, graph: null, view: defaultView(), trail: [] }
}

export function tableOf(
  state: AppState,
  name: string,
): SchemaTable | undefined {
  return state.report?.tables.find(table => table.name === name)
}

/**
 * Whether this table may be edited, decided **once, before first paint**.
 *
 * Two independent reasons it may not be, and the client is told both by
 * `/api/_db/schema` rather than discovering them at save time: the session may
 * be `read`, or the table may have no identity. Drawing an editable grid and
 * then refusing the save is the failure this answers early.
 */
export function editableTable(
  state: AppState,
  table: SchemaTable | undefined,
): boolean {
  if (!table) return false
  return state.report?.access === 'write' && table.writable
}

/** Why not, in the words the server used. Never invented here. */
export function readOnlyReason(
  state: AppState,
  table: SchemaTable | undefined,
): string {
  if (!table) return 'no table selected'
  if (state.report?.access !== 'write') {
    return table.reason ?? 'this session may read but not write'
  }
  return table.reason ?? table.identity.reason ?? 'this table is read-only'
}
