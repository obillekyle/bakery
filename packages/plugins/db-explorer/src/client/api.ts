/**
 * Every request this client makes, and nothing that renders.
 *
 * The rule that keeps the grid's complexity down is mechanical: **no function
 * both fetches and renders.** These return data or throw `ApiError`; the DOM
 * modules take data and return nodes. The old `renderTable` did both and scored
 * 34 against a maximum of 25 with a fraction of this feature set.
 */

import { toWire } from '../shared/filters'
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

/**
 * What to show a user when a call threw.
 *
 * Here rather than in `dom.ts` because the thing it knows about is `ApiError`,
 * whose `message` is the server's own sentence from the envelope — the reason
 * a failed write reads as "row was modified by someone else" instead of
 * "Request failed (409)". `String(error)` is the fallback for the two throws
 * that are not ours: an abort and a network failure.
 *
 * There used to be three of these — one exported from `bulk.ts`, a private
 * near-copy in `save.ts`, and a third inlined at the `notify` call in
 * `csv-commit.ts` — so improving the wording in one left the other two alone.
 */
export function messageOf(error: unknown): string {
  const api = error as Partial<ApiError>
  return api?.message ?? String(error)
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
  /** Milliseconds the server spent, filled in by `router.ts`. */
  time?: number
}

/**
 * The data, plus what the server said it cost.
 *
 * `time` is the envelope's own field — `router.ts` fills it from `getElapsed`,
 * so it is the server's measurement of its own work rather than a round trip
 * timed in the browser. The status bar shows it, which is the one honest number
 * available for "why is this slow": a filter that cannot use an index shows up
 * here immediately.
 */
interface Timed<T> {
  data: T
  ms: number
}

async function unwrapEnvelope<T>(res: Response): Promise<Timed<T>> {
  const body = (await res.json().catch(() => null)) as Envelope | null
  const status = body?.status ?? res.status
  if (!body || status < 200 || status >= 300) {
    throw new ApiError(
      body?.message || `Request failed (${status})`,
      status,
      body?.data,
    )
  }
  return { data: body.data as T, ms: body.time ?? 0 }
}

async function unwrap<T>(res: Response): Promise<T> {
  return (await unwrapEnvelope<T>(res)).data
}

async function apiGet<T>(
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

async function apiSend<T>(
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
 * One page of a table, with the server's own timing.
 *
 * **`filters` carries an operator now.** It used to be a bare column→substring
 * record, which meant `col LIKE '%value%'` and nothing else — so a filter could
 * narrow a page but could never *name* a row, `1` matching `11` and `21`. With
 * `eq` in the vocabulary it can, which is what removed `ViewState.focus` and
 * turned a foreign-key jump into an ordinary filter.
 *
 * The scalar form is still what the endpoint accepts from anyone else; `toWire`
 * always sends the object form from here.
 */
export async function fetchPage(view: ViewState): Promise<Timed<TablePage>> {
  const params: Record<string, string> = {
    tableName: view.table,
    page: String(view.page),
    pageSize: String(PAGE_SIZE),
    sortOrder: view.sortOrder,
  }
  if (view.sortBy) params.sortBy = view.sortBy
  const wire = toWire(view.filters)
  if (Object.keys(wire).length) params.filters = JSON.stringify(wire)

  const query = `?${new URLSearchParams(params)}`
  const res = await fetch(`/api/_db/table-data${query}`, {
    headers: keyHeaders(),
  })
  return await unwrapEnvelope<TablePage>(res)
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

interface UpdateResult {
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

interface BulkResult {
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

interface DeleteResult {
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

interface InsertResult {
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
