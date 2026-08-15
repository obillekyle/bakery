/**
 * Turning a spreadsheet into statements: which CSV column feeds which database
 * column, what stops an import before it starts, and what one row edit changes.
 *
 * **Pure** — see the note at the top of `coerce.ts`. The import dialog runs
 * `autoMap` and `blockingIssues` in the browser to show the mapping before
 * anything is sent, and the server runs the same two functions on what arrives,
 * because a client-side check is a convenience and never a guarantee.
 */

import { type ColumnMeta, omittableOnInsert, sameValue } from './coerce'

/** A column as both sides refer to it: the raw database name, plus its meta. */
export interface PlanColumn {
  name: string
  meta: ColumnMeta
}

/** CSV header → database column name, or `null` for "do not import". */
export type ColumnMapping = Record<string, string | null>

/**
 * Match headers to columns without asking the user first.
 *
 * Exact name wins, then a case- and separator-insensitive match, so
 * `Courier Name`, `courier_name` and `courierName` all find `courier_name`.
 * Nothing fuzzier: a near-miss that silently loads the wrong column is worse
 * than an unmapped one the dialog can ask about.
 *
 * A database column is claimed at most once. Two headers that normalise to the
 * same name would otherwise both map to it, and the second would quietly win.
 */
export function autoMap(
  csvHeaders: readonly string[],
  dbColumns: readonly string[],
): ColumnMapping {
  const mapping: ColumnMapping = {}
  const claimed = new Set<string>()

  const byExact = new Map(dbColumns.map(c => [c, c]))
  const byNormal = new Map<string, string>()
  for (const c of dbColumns) {
    const key = normalize(c)
    // First declaration wins, so the mapping does not depend on column order
    // among columns that normalise alike.
    if (!byNormal.has(key)) byNormal.set(key, c)
  }

  for (const header of csvHeaders) {
    const match = byExact.get(header) ?? byNormal.get(normalize(header)) ?? null
    mapping[header] = match && !claimed.has(match) ? match : null
    if (mapping[header]) claimed.add(match!)
  }
  return mapping
}

/**
 * A name with case and separators removed.
 *
 * Exported because `client/meta.ts` compares *table* names the same way and
 * held a byte-identical private copy called `flatten`. Both are in the browser
 * bundle, so it was one rule written twice: a change to what counts as "the
 * same name" would have fixed CSV auto-mapping and left foreign-key visibility
 * on the old one.
 */
export function normalize(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '')
}

export interface PlanIssue {
  column: string
  code: 'required_unmapped' | 'unknown_column' | 'duplicate_target'
  message: string
}

/**
 * What makes this mapping unrunnable, as opposed to merely lossy.
 *
 * A column left out of the mapping is fine when the database can fill it in —
 * an auto-increment key, a default, or a nullable column. A NOT NULL column
 * with no default and no mapping is not: every row would fail at the database,
 * one at a time, after the import had already started.
 */
export function blockingIssues(
  mapping: ColumnMapping,
  columns: readonly PlanColumn[],
): PlanIssue[] {
  const issues: PlanIssue[] = []
  const known = new Set(columns.map(c => c.name))
  const targets = Object.values(mapping).filter(Boolean) as string[]

  for (const target of new Set(targets)) {
    if (!known.has(target)) {
      issues.push({
        column: target,
        code: 'unknown_column',
        message: `no column named ${target}`,
      })
    }
    if (targets.filter(t => t === target).length > 1) {
      issues.push({
        column: target,
        code: 'duplicate_target',
        message: `two headers are mapped to ${target}`,
      })
    }
  }

  const mapped = new Set(targets)
  for (const column of columns) {
    if (mapped.has(column.name)) continue
    if (omittableOnInsert(column.meta)) continue
    issues.push({
      column: column.name,
      code: 'required_unmapped',
      message: `${column.name} cannot be null and has no default, so it must be mapped`,
    })
  }

  return issues
}

export interface UpdatePlanInput {
  /** The row as the editor last saw it, keyed by raw column name. */
  original: Record<string, unknown>
  /** Edited values. **An absent key means unchanged** — see `coerce.ts`. */
  edits: Record<string, unknown>
  /** The identity columns, from `describeIdentity`. */
  identity: readonly string[]
}

export interface UpdatePlanResult {
  /** Columns whose value actually differs, and the value to write. */
  set: Record<string, unknown>
  /** The identity predicate, taken from `original`. */
  where: Record<string, unknown>
  /** Edited keys that matched what was already there. */
  unchanged: string[]
  /** Identity columns `original` does not carry — the plan is unusable. */
  missingIdentity: string[]
}

/**
 * One row edit, as the two halves of an UPDATE.
 *
 * `where` comes from `original` and never from `edits`, which is the point of
 * separating them: editing a primary key has to find the row by its *old* value
 * and set the new one, and a plan built from the edited row would look for a
 * row that does not exist yet.
 *
 * Unchanged columns are dropped from `set`. That is not only economy — a `set`
 * carrying every column makes two people editing different columns of the same
 * row collide, and the whole reason to send a narrow statement is that they
 * should not.
 */
export function updatePlan(input: UpdatePlanInput): UpdatePlanResult {
  const set: Record<string, unknown> = {}
  const unchanged: string[] = []

  for (const [column, value] of Object.entries(input.edits)) {
    if (sameValue(input.original[column], value)) unchanged.push(column)
    else set[column] = value
  }

  const where: Record<string, unknown> = {}
  const missingIdentity: string[] = []
  for (const column of input.identity) {
    if (!(column in input.original)) missingIdentity.push(column)
    else where[column] = input.original[column]
  }

  return { set, where, unchanged, missingIdentity }
}
