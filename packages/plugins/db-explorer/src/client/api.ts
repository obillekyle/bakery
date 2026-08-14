/**
 * Every request this client makes, and nothing that renders.
 *
 * The rule that keeps the grid's complexity down is mechanical: **no function
 * both fetches and renders.** These return data or throw `ApiError`; the DOM
 * modules take data and return nodes. The old `renderTable` did both and scored
 * 34 against a maximum of 25 with a fraction of this feature set.
 */

import type { SchemaGraph, SchemaReport, TablePage } from './meta'
import type { ViewState } from './state'
import { PAGE_SIZE } from './state'

/**
 * A failed call, with the server's own envelope attached.
 *
 * `data` matters as much as the status: a 409 from `PATCH /api/_db/row` carries
 * the row as it now stands, which is what makes *Keep mine / Take theirs*
 * possible rather than "please try again".
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const KEY_STORAGE = '__db_key'
const KEY_PARAM = 'db-key'

/**
 * Take a `?db-key=` out of the address bar and keep it for the session.
 *
 * A human opening a link cannot set a header, so the credential arrives in the
 * URL; leaving it there puts it in history, in the referrer of every outbound
 * link, and in a screenshot. It is moved to `sessionStorage` and the URL is
 * rewritten before anything else runs.
 */
export function adoptUrlKey(): void {
  const url = new URL(location.href)
  const key = url.searchParams.get(KEY_PARAM)
  if (!key) return
  sessionStorage.setItem(KEY_STORAGE, key)
  url.searchParams.delete(KEY_PARAM)
  history.replaceState(null, '', url)
}

/**
 * The credential as a **header**.
 *
 * Never as a query parameter on a write: `access.ts` refuses a URL credential
 * on any non-safe method, because a link is something a cross-site page can
 * make the browser follow and `checkCsrf` passes when `Origin` is absent.
 */
function keyHeaders(): Record<string, string> {
  const key = sessionStorage.getItem(KEY_STORAGE)
  return key ? { 'x-db-key': key } : {}
}

interface Envelope {
  status?: number
  message?: string
  data?: unknown
}

async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as Envelope | null
  const status = body?.status ?? res.status
  if (!body || status < 200 || status >= 300) {
    throw new ApiError(
      body?.message || `Request failed (${status})`,
      status,
      body?.data,
    )
  }
  return body.data as T
}

export async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const query = params ? `?${new URLSearchParams(params)}` : ''
  const res = await fetch(`/api/_db/${path}${query}`, {
    headers: keyHeaders(),
    signal,
  })
  return await unwrap<T>(res)
}

export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(`/api/_db/${path}`, {
    method,
    headers: { ...keyHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  return await unwrap<T>(res)
}

export async function fetchSchema(): Promise<SchemaReport> {
  return await apiGet<SchemaReport>('schema')
}

export async function fetchGraph(): Promise<SchemaGraph> {
  return await apiGet<SchemaGraph>('graph')
}

/**
 * One page of a table.
 *
 * **`filters` is a substring match, not equality** — `buildFilterSort` in the
 * ORM's base adapter emits `col LIKE '%value%'` — so it narrows a page and
 * cannot name a row. That is why `ViewState.focus` exists separately: the
 * filter gets the row onto a page, the focus identifies it once it is there.
 * Anything written here that assumes `filters` selects exactly one row is
 * wrong on any table where `1` is also a substring of `11`.
 */
export async function fetchPage(view: ViewState): Promise<TablePage> {
  const params: Record<string, string> = {
    tableName: view.table,
    page: String(view.page),
    pageSize: String(PAGE_SIZE),
    sortOrder: view.sortOrder,
  }
  if (view.sortBy) params.sortBy = view.sortBy
  if (Object.keys(view.filters).length) {
    params.filters = JSON.stringify(view.filters)
  }
  return await apiGet<TablePage>('table-data', params)
}

export interface LookupRef {
  table: string
  key: Record<string, unknown>
}

export interface LookupResult {
  table: string
  key: Record<string, unknown>
  row: Record<string, unknown> | null
}

/** Bounded at 200 by `policy.ts`; `fk.ts` never sends more than a page's worth. */
export async function lookupRefs(
  refs: LookupRef[],
  signal?: AbortSignal,
): Promise<LookupResult[]> {
  const data = await apiSend<{ rows: LookupResult[] }>(
    'POST',
    'lookup',
    { refs },
    signal,
  )
  return data.rows ?? []
}

export interface UpdateResult {
  changed: number
  row: Record<string, unknown> | null
}

export async function patchRow(payload: {
  table: string
  key: Record<string, unknown>
  set: Record<string, unknown>
  expect: Record<string, unknown>
  force?: boolean
}): Promise<UpdateResult> {
  return await apiSend<UpdateResult>('PATCH', 'row', payload)
}

export interface BulkResult {
  changed: number
  conflicts: { index: number; key: Record<string, unknown>; reason: string }[]
}

export async function bulkEdit(payload: {
  table: string
  edits: { key: Record<string, unknown>; set: Record<string, unknown> }[]
  dryRun?: boolean
}): Promise<BulkResult> {
  return await apiSend<BulkResult>('POST', 'rows/bulk', payload)
}

export interface DeleteResult {
  deleted: number
  conflicts: { index: number; key: Record<string, unknown>; reason: string }[]
}

export async function deleteRows(payload: {
  table: string
  keys: Record<string, unknown>[]
  dryRun?: boolean
}): Promise<DeleteResult> {
  return await apiSend<DeleteResult>('DELETE', 'rows', payload)
}

export interface InsertResult {
  inserted: number
  rows?: Record<string, unknown>[]
}

export async function insertRows(payload: {
  table: string
  rows: Record<string, unknown>[]
}): Promise<InsertResult> {
  return await apiSend<InsertResult>('POST', 'rows', payload)
}

export interface ImportResult {
  inserted: number
  skipped: number
  errors: { row: number; column: string; code: string; message: string }[]
}

export async function importRows(payload: {
  table: string
  rows: Record<string, unknown>[]
  onBadRow: 'stop' | 'skip'
  dryRun?: boolean
}): Promise<ImportResult> {
  return await apiSend<ImportResult>('POST', 'import', payload)
}
