/**
 * The import wizard's state, with no DOM anywhere in it.
 *
 * The wizard has five steps and the interesting behaviour is all in the
 * transitions between them — a re-pick *moves* a database column rather than
 * duplicating it, an unmapped NOT NULL column blocks, `empty → NULL` defaults
 * differently per kind, and the preview recomputes from the mapping every
 * time. None of that is testable through a rendered `<select>`, so none of it
 * lives there. `csv.ts` is the view; this is the machine.
 *
 * Parsing, coercion and mapping are **not reimplemented** — `shared/csv.ts`,
 * `shared/coerce.ts` and `shared/plan.ts` are the same modules the server runs,
 * which is the only way the preview and the outcome agree.
 */

import { coerceValue } from '../shared/coerce'
import { parseCSVRows, sniffDelimiter } from '../shared/csv'
import {
  autoMap,
  blockingIssues,
  type ColumnMapping,
  type PlanIssue,
} from '../shared/plan'
import { columnMeta, type SchemaColumn } from './meta'

/** What one CSV column feeds. */
export type Assignment =
  | { kind: 'skip' }
  | { kind: 'column'; column: string }
  /** Ignore this CSV column; write a literal into `column` on every row. */
  | { kind: 'constant'; column: string | null; text: string }

export type BadRowPolicy = 'skip' | 'stop' | 'all'

export interface ImportModel {
  headers: string[]
  rows: string[][]
  delimiter: string
  hasHeader: boolean
  /** By CSV header. */
  assign: Record<string, Assignment>
  /** By database column. Defaults on for every kind except text. */
  emptyToNull: Record<string, boolean>
  onBadRow: BadRowPolicy
  /** Rows whose field count differed from the header count. */
  ragged: { row: number; fields: number }[]
}

const SKIP: Assignment = { kind: 'skip' }

/** The database column an assignment claims, or `null`. */
export function targetOf(assignment: Assignment): string | null {
  if (assignment.kind === 'column') return assignment.column
  if (assignment.kind === 'constant') return assignment.column
  return null
}

/**
 * Does row 0 name the columns?
 *
 * Non-empty, unique, and not a number — the three properties a header row has
 * and a data row almost never does. Deliberately conservative in the direction
 * of *yes*: guessing "header" for a data file loses one row in a preview the
 * user is looking at, while guessing "data" for a header file maps nothing and
 * looks like the file is broken.
 */
export function looksLikeHeader(rows: readonly string[][]): boolean {
  const first = rows[0]
  if (!first?.length) return false
  const seen = new Set<string>()
  for (const field of first) {
    const value = field.trim()
    if (!value) return false
    if (seen.has(value)) return false
    seen.add(value)
    if (Number.isFinite(Number(value))) return false
  }
  return true
}

function synthHeaders(width: number): string[] {
  return Array.from({ length: width }, (_v, i) => `Column ${i + 1}`)
}

function square(fields: string[], width: number): string[] {
  const out = fields.slice(0, width)
  while (out.length < width) out.push('')
  return out
}

/**
 * Empty means NULL by default for everything except text.
 *
 * `''` in a numeric or date column is never a value — `coerceValue` refuses it
 * outright with `empty_string` — so defaulting the toggle off there guarantees
 * a failure the user then has to diagnose. In a text column `''` *is* a value,
 * and silently turning every blank cell into NULL would be the dashboard's bug
 * with a checkbox on it.
 */
function defaultEmptyToNull(
  columns: readonly SchemaColumn[],
): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const column of columns) out[column.name] = column.kind !== 'string'
  return out
}

export interface BuildOptions {
  delimiter?: string
  hasHeader?: boolean
}

/** Parse a file into a model with the mapping already guessed. */
export function buildModel(
  text: string,
  columns: readonly SchemaColumn[],
  options: BuildOptions = {},
): ImportModel {
  const delimiter = options.delimiter ?? sniffDelimiter(text)
  const all = parseCSVRows(text, delimiter)
  const hasHeader = options.hasHeader ?? looksLikeHeader(all)

  const width = all.reduce((max, row) => Math.max(max, row.length), 0)
  const headers = hasHeader
    ? square(all[0] ?? [], width).map(h => h.trim())
    : synthHeaders(width)
  const body = hasHeader ? all.slice(1) : all

  const ragged: { row: number; fields: number }[] = []
  const rows = body.map((fields, index) => {
    if (fields.length !== headers.length) {
      ragged.push({ row: index + 1, fields: fields.length })
    }
    return square(fields, headers.length)
  })

  const guessed = autoMap(
    headers,
    columns.map(c => c.name),
  )
  const assign: Record<string, Assignment> = {}
  for (const header of headers) {
    const match = guessed[header]
    assign[header] = match ? { kind: 'column', column: match } : SKIP
  }

  return {
    headers,
    rows,
    delimiter,
    hasHeader,
    assign,
    emptyToNull: defaultEmptyToNull(columns),
    onBadRow: 'skip',
    ragged,
  }
}

/**
 * Re-assign one CSV column, **moving** the target rather than sharing it.
 *
 * Any other header holding the same database column falls back to skip. That
 * makes a duplicate mapping impossible to express, which is a stronger promise
 * than `blockingIssues`' `duplicate_target` — that check stays as the
 * server-side guarantee, because the server accepts a mapping this UI did not
 * build.
 */
export function reassign(
  model: ImportModel,
  header: string,
  next: Assignment,
): ImportModel {
  const target = targetOf(next)
  const assign: Record<string, Assignment> = {}
  for (const [key, current] of Object.entries(model.assign)) {
    if (key === header) assign[key] = next
    else if (target && targetOf(current) === target) assign[key] = SKIP
    else assign[key] = current
  }
  return { ...model, assign }
}

export function setEmptyToNull(
  model: ImportModel,
  column: string,
  value: boolean,
): ImportModel {
  return { ...model, emptyToNull: { ...model.emptyToNull, [column]: value } }
}

export function setBadRowPolicy(
  model: ImportModel,
  onBadRow: BadRowPolicy,
): ImportModel {
  return { ...model, onBadRow }
}

/** The mapping in `shared/plan.ts`'s vocabulary, constants included. */
export function mappingOf(model: ImportModel): ColumnMapping {
  const mapping: ColumnMapping = {}
  for (const [header, assignment] of Object.entries(model.assign)) {
    mapping[header] = targetOf(assignment)
  }
  return mapping
}

export interface ModelIssues {
  /** What stops the import. `blockingIssues` decides, not this module. */
  blocking: PlanIssue[]
  /** CSV columns going nowhere. Fine, but counted and named. */
  unmatched: string[]
  /** Database columns nobody feeds, with why that is or is not a problem. */
  unmapped: { column: string; status: 'required' | 'default' | 'nullable' }[]
}

export function issuesOf(
  model: ImportModel,
  columns: readonly SchemaColumn[],
): ModelIssues {
  const mapping = mappingOf(model)
  const blocking = blockingIssues(
    mapping,
    columns.map(c => ({ name: c.name, meta: columnMeta(c) })),
  )
  const claimed = new Set(Object.values(mapping).filter(Boolean) as string[])
  const unmatched = model.headers.filter(header => !mapping[header])
  const unmapped = columns
    .filter(column => !claimed.has(column.name))
    .map(column => ({ column: column.name, status: statusOf(column) }))
  return { blocking, unmatched, unmapped }
}

function statusOf(column: SchemaColumn): 'required' | 'default' | 'nullable' {
  if (column.autoIncrement || column.hasDefault) return 'default'
  if (column.nullable) return 'nullable'
  return 'required'
}

export interface CellPreview {
  column: string
  /** Exactly what the file said, or the constant. */
  raw: string
  ok: boolean
  value?: unknown
  message?: string
}

export interface RowPreview {
  /** 1-based over the data rows, so it matches what a spreadsheet shows. */
  index: number
  cells: CellPreview[]
  ok: boolean
}

/**
 * One CSV field, through the same coercer the server will run.
 *
 * The `empty → NULL` toggle happens *before* coercion, which is the only
 * ordering that works: `coerceValue` refuses `''` on every non-text kind, so a
 * toggle applied afterwards would never be reached.
 */
function coerceField(
  raw: string,
  column: SchemaColumn,
  emptyToNull: boolean,
): CellPreview {
  const input = raw === '' && emptyToNull ? null : raw
  const result = coerceValue(input, columnMeta(column))
  if (result.ok)
    return { column: column.name, raw, ok: true, value: result.value }
  return { column: column.name, raw, ok: false, message: result.message }
}

interface Feed {
  column: SchemaColumn
  /** Where the value comes from: a CSV field index, or a literal. */
  index: number | null
  constant: string
}

/** The assignments resolved to actual sources, once per pass rather than per row. */
function feedsOf(model: ImportModel, columns: readonly SchemaColumn[]): Feed[] {
  const byName = new Map(columns.map(column => [column.name, column]))
  const feeds: Feed[] = []
  model.headers.forEach((header, index) => {
    const assignment = model.assign[header] ?? SKIP
    const target = targetOf(assignment)
    const column = target ? byName.get(target) : undefined
    if (!column) return
    if (assignment.kind === 'constant') {
      feeds.push({ column, index: null, constant: assignment.text })
    } else {
      feeds.push({ column, index, constant: '' })
    }
  })
  return feeds
}

function previewRow(
  model: ImportModel,
  feeds: readonly Feed[],
  fields: readonly string[],
  index: number,
): RowPreview {
  const cells = feeds.map(feed => {
    const raw = feed.index === null ? feed.constant : (fields[feed.index] ?? '')
    return coerceField(
      raw,
      feed.column,
      model.emptyToNull[feed.column.name] ?? false,
    )
  })
  return { index: index + 1, cells, ok: cells.every(cell => cell.ok) }
}

/** The first `limit` rows, coerced. Recomputed on every mapping change. */
export function previewRows(
  model: ImportModel,
  columns: readonly SchemaColumn[],
  limit = 10,
): RowPreview[] {
  const feeds = feedsOf(model, columns)
  return model.rows
    .slice(0, limit)
    .map((fields, index) => previewRow(model, feeds, fields, index))
}

export interface RowFailure {
  /** 1-based over the data rows. */
  index: number
  fields: string[]
  message: string
}

export interface BuildResult {
  records: Record<string, unknown>[]
  failures: RowFailure[]
}

/**
 * Every row, as records to send and rows that could not be built.
 *
 * One pass over the file. The wizard's live bad-row count is
 * `failures.length` from this same call rather than a second walk, because two
 * walks over fifty thousand rows is the difference between a responsive dialog
 * and a frozen tab.
 */
export function buildRecords(
  model: ImportModel,
  columns: readonly SchemaColumn[],
): BuildResult {
  const feeds = feedsOf(model, columns)
  const records: Record<string, unknown>[] = []
  const failures: RowFailure[] = []

  model.rows.forEach((fields, index) => {
    const preview = previewRow(model, feeds, fields, index)
    if (!preview.ok) {
      const bad = preview.cells.find(cell => !cell.ok)!
      failures.push({
        index: index + 1,
        fields: [...fields],
        message: `${bad.column}: ${bad.message}`,
      })
      return
    }
    const record: Record<string, unknown> = {}
    for (const cell of preview.cells) record[cell.column] = cell.value
    records.push(record)
  })

  return { records, failures }
}

/** RFC 4180 quoting: only when the field needs it, and `"` doubles. */
function quote(field: string, delimiter: string): string {
  const needs =
    field.includes(delimiter) ||
    field.includes('"') ||
    field.includes('\n') ||
    field.includes('\r')
  return needs ? `"${field.replace(/"/g, '""')}"` : field
}

export function writeCSV(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  delimiter = ',',
): string {
  const line = (fields: readonly string[]) =>
    fields.map(field => quote(field, delimiter)).join(delimiter)
  return [line(headers), ...rows.map(line)].join('\r\n')
}

/**
 * The rows that did not import, as a file the user can fix and re-drop.
 *
 * The original fields, unmodified, plus a trailing `_error` column. Unmodified
 * matters: a rejected-rows export that had been through the coercer would have
 * lost the very text that explains why it was rejected.
 */
export function rejectedCSV(
  model: ImportModel,
  failures: readonly RowFailure[],
): string {
  return writeCSV(
    [...model.headers, '_error'],
    failures.map(failure => [...failure.fields, failure.message]),
    model.delimiter,
  )
}

/** Send in slices so a fifty-thousand-row file is not one request. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[])
  }
  return out
}
