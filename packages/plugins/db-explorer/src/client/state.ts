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

import type { Filter } from '../shared/filters'
import { isFilterOp } from '../shared/filters'
import type { SchemaGraph, SchemaReport, SchemaTable } from './meta'

export const PAGE_SIZE = 50

/** The three views a table has. One level of nesting, and only one. */
export type TableView = 'data' | 'structure' | 'relations'

const TABLE_VIEWS: readonly TableView[] = ['data', 'structure', 'relations']

export interface ViewState {
  table: string
  /** Which of Data / Structure / Relations is showing. */
  view: TableView
  page: number
  sortBy: string | null
  sortOrder: 'ASC' | 'DESC'
  /**
   * Column, operator and operand — several, each removable.
   *
   * A **list** rather than a record, because the builder lets a filter exist
   * before it has a column or a value and a record cannot hold a half-built
   * one. `toWire` is what collapses it to the record `getData` takes.
   */
  filters: Filter[]
}

export function defaultView(table = ''): ViewState {
  return {
    table,
    view: 'data',
    page: 1,
    sortBy: null,
    sortOrder: 'ASC',
    filters: [],
  }
}

/**
 * `t` table, `v` view, `p` page, `s` sort column, `o` order, `f` filters.
 *
 * Short keys because several of these are encoded per open tab and the whole
 * thing has to stay something a person can paste into chat. Defaults are
 * omitted rather than written, so the common case is `t=parcels`.
 *
 * There is no `r` any more. It carried a row identity because a filter could
 * not name a row — `id=1` matched `11` under a substring `LIKE` — and with `eq`
 * available a foreign-key jump is just a filter. An old link with `r=` decodes
 * to the same page it always did, minus the highlight.
 */
export function encodeView(view: ViewState): string {
  const params = new URLSearchParams()
  if (view.table) params.set('t', view.table)
  if (view.view !== 'data') params.set('v', view.view)
  if (view.page > 1) params.set('p', String(view.page))
  if (view.sortBy) {
    params.set('s', view.sortBy)
    if (view.sortOrder === 'DESC') params.set('o', 'DESC')
  }
  if (view.filters.length) params.set('f', JSON.stringify(view.filters))
  return params.toString()
}

export function decodeView(hash: string): ViewState {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const view = defaultView(params.get('t') ?? '')
  view.view = readTableView(params.get('v'))
  const page = Number.parseInt(params.get('p') ?? '1', 10)
  view.page = Number.isFinite(page) && page > 0 ? page : 1
  view.sortBy = params.get('s')
  view.sortOrder = params.get('o') === 'DESC' ? 'DESC' : 'ASC'
  view.filters = readFilters(params.get('f'))
  return view
}

function readTableView(raw: string | null): TableView {
  return TABLE_VIEWS.find(name => name === raw) ?? 'data'
}

/**
 * Filters out of a URL, or none.
 *
 * Nothing here is trusted: the hash is user-supplied, and a filter carrying an
 * operator the ORM does not know would be *dropped* server-side and quietly
 * widen the result. Anything that does not typecheck as a filter is discarded
 * here, before it can be sent.
 */
function readFilters(raw: string | null): Filter[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A truncated or hand-edited link. Falling back to "no filters" renders
    // the table the link asked for, which beats an error page.
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed.filter(isFilter)
}

function isFilter(value: unknown): value is Filter {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.column === 'string' &&
    entry.column !== '' &&
    isFilterOp(entry.op) &&
    (entry.value === undefined || typeof entry.value === 'string')
  )
}

/** Everything the running client holds. One object, mutated in place. */
export interface AppState {
  report: SchemaReport | null
  graph: SchemaGraph | null
  /** Views to return to, pushed by a foreign-key jump. */
  trail: ViewState[]
  /** Whether the sidebar lists the framework's own tables. Off by default. */
  showSystem: boolean
}

export function createState(): AppState {
  return { report: null, graph: null, trail: [], showSystem: false }
}

export function tableOf(
  state: AppState,
  name: string,
): SchemaTable | undefined {
  return state.report?.tables.find(table => table.name === name)
}

/**
 * The ORM's own bookkeeping, which is not the user's data.
 *
 * `__bakery_schema` is the sync ledger (`orm/src/sync/ledger.ts`), and
 * `__bakery` is the reserved prefix convention 10 names. Matching the prefix
 * rather than the one literal name means a second ledger table would be hidden
 * on the day it lands rather than on the day someone notices.
 *
 * Matched against the **raw** database name, which is what the schema report
 * carries: `introspect()` builds from `getSchema()`, and that speaks raw names.
 * (`getConstraints()` camel-cases, so the same table is `bakerySchema` there —
 * that spelling never reaches this client, and matching it here would risk
 * hiding a user table that happens to be called `bakerySchema`.)
 */
const SYSTEM_PREFIX = '__bakery'

export function isSystemTable(name: string): boolean {
  return name.startsWith(SYSTEM_PREFIX)
}

/**
 * The tables the sidebar shows.
 *
 * Hidden behind a checkbox rather than removed outright, because every real
 * client offers the toggle: a ledger row is occasionally exactly what someone
 * needs to look at, and a table that cannot be reached at all is a support
 * question.
 */
export function visibleTables(
  tables: readonly SchemaTable[],
  showSystem: boolean,
): SchemaTable[] {
  return showSystem ? [...tables] : tables.filter(t => !isSystemTable(t.name))
}

/** How many are being hidden, for the checkbox's own label. */
export function systemTableCount(tables: readonly SchemaTable[]): number {
  return tables.filter(table => isSystemTable(table.name)).length
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
