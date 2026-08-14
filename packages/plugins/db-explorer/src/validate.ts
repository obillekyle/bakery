/**
 * Turning a request body into bound values, or into a list of what is wrong
 * with it.
 *
 * Two rules run through every function here.
 *
 * **Errors accumulate.** A 400 names every bad field, not the first one — a
 * fifty-row paste fixed one error per round trip is fifty round trips, and the
 * user cannot see the shape of their mistake.
 *
 * **Nothing is applied partially.** These functions only ever *describe* a
 * write; the caller runs the statement, and only when the error list is empty.
 * That is what makes "413 with nothing executed" and "400 with nothing
 * executed" true statements rather than intentions.
 *
 * And an unknown column is an error, never a silently dropped key. A typo'd
 * column in an edit that reports success is a row the user believes they
 * changed and did not.
 */

import type { ColumnFacts, TableFacts } from './identity'
import {
  type ColumnMeta,
  coerceValue,
  comparableKind,
  omittableOnInsert,
} from './shared/coerce'

export interface FieldError {
  /** 0-based index into the request's `rows`/`edits`/`keys` array. */
  row: number
  column: string
  code: string
  message: string
}

export interface Validated {
  /** Raw database column name → bound value. */
  values: Record<string, unknown>
  errors: FieldError[]
}

/** A request body member that has to be a plain object before anything else. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const error = (
  row: number,
  column: string,
  code: string,
  message: string,
): FieldError => ({ row, column, code, message })

/**
 * Resolve a wire column name against the table.
 *
 * Accepts the raw database name, and the camel spelling as a courtesy — the
 * grid renders raw names, but a script written against a typed schema has camel
 * ones and the two are the same column. Anything else is `unknown_column`.
 */
function findColumn(table: TableFacts, name: string): ColumnFacts | undefined {
  return (
    table.byName.get(name) ??
    table.columns.find(column => column.camel === name)
  )
}

function coerceInto(
  values: Record<string, unknown>,
  errors: FieldError[],
  row: number,
  column: ColumnFacts,
  raw: unknown,
): void {
  const result = coerceValue(raw, column.meta)
  if (result.ok) values[column.name] = result.value
  else errors.push(error(row, column.name, result.code, result.message))
}

/**
 * A whole row, for an INSERT.
 *
 * Every column is considered, not only the ones the caller sent: an absent key
 * is fine when the database can fill it in (auto-increment, a default, or
 * nullable) and is a `required` error otherwise. Refusing here rather than at
 * the database is what keeps a 1,000-row insert from failing on row 700 with
 * 699 rows already written — the whole statement is known to be well-formed
 * before any of it runs.
 */
export function validateInsertRow(
  input: unknown,
  table: TableFacts,
  row: number,
): Validated {
  const values: Record<string, unknown> = {}
  const errors: FieldError[] = []

  if (!isRecord(input)) {
    return {
      values,
      errors: [error(row, '', 'not_a_row', 'expected an object')],
    }
  }

  const seen = new Set<string>()
  for (const [name, raw] of Object.entries(input)) {
    const column = findColumn(table, name)
    if (!column) {
      errors.push(error(row, name, 'unknown_column', `no column named ${name}`))
      continue
    }
    seen.add(column.name)
    coerceInto(values, errors, row, column, raw)
  }

  for (const column of table.columns) {
    if (seen.has(column.name)) continue
    if (omittableOnInsert(column.meta)) continue
    errors.push(
      error(
        row,
        column.name,
        'required',
        `${column.name} cannot be null and has no default`,
      ),
    )
  }

  return { values, errors }
}

export interface PartialOptions {
  /**
   * Whether a `json` or `buffer` column may appear.
   *
   * `false` for `expect`, where the answer is not "be careful" but "this cannot
   * be expressed": those two kinds have no portable equality predicate — see
   * `comparableKind` — so an `expect` over one is a condition that never
   * matches, which reads to the caller as a permanent conflict.
   */
  allowUncomparable: boolean
  /** Which field of the request this is, for the message. */
  label: string
}

/**
 * A partial row — the `set` of an update, or the `expect` it is guarded by.
 *
 * Absent keys are absent, and that is the point: this function has no concept
 * of a default, because "the caller did not mention this column" means "leave
 * it alone" everywhere it is used.
 */
export function validatePartial(
  input: unknown,
  table: TableFacts,
  row: number,
  options: PartialOptions,
): Validated {
  const values: Record<string, unknown> = {}
  const errors: FieldError[] = []

  if (!isRecord(input)) {
    return {
      values,
      errors: [
        error(row, '', 'not_an_object', `${options.label} must be an object`),
      ],
    }
  }

  for (const [name, raw] of Object.entries(input)) {
    const column = findColumn(table, name)
    if (!column) {
      errors.push(error(row, name, 'unknown_column', `no column named ${name}`))
      continue
    }
    if (!options.allowUncomparable && !comparableKind(column.meta.kind)) {
      errors.push(
        error(
          row,
          column.name,
          'uncomparable',
          `a ${column.meta.kind} column cannot be compared in ${options.label}; ` +
            'no dialect agrees on equality for one',
        ),
      )
      continue
    }
    coerceInto(values, errors, row, column, raw)
  }

  return { values, errors }
}

/**
 * The columns of `set` that may only be written with `force`.
 *
 * A `json` or `buffer` column cannot appear in `expect`, so an edit to one is
 * unguarded by construction — it overwrites whatever is there, including
 * whatever somebody else wrote a moment ago. `force` is how the caller says
 * they know that. It is not a permission; it is an acknowledgement.
 */
export function unguardableColumns(
  values: Record<string, unknown>,
  table: TableFacts,
): string[] {
  return Object.keys(values).filter(name => {
    const meta: ColumnMeta | undefined = table.byName.get(name)?.meta
    return meta ? !comparableKind(meta.kind) : false
  })
}

export interface ValidatedKey {
  /** Raw column name → bound value, for the identity predicate. */
  where: Record<string, unknown>
  errors: FieldError[]
}

/**
 * A wire key, against the table's identity.
 *
 * **The column set must be exactly equal** — not a subset, not a superset. A
 * subset is a predicate that matches more than one row, which for a composite
 * key is precisely the dashboard's bug (its MySQL path addresses rows by the
 * *first* primary-key column, so one edit rewrites every row sharing it). A
 * superset is a caller who believes the key contains something it does not, and
 * silently ignoring the extra column would confirm that belief.
 *
 * The key is transparent by design — `{ col: value }` rather than an opaque
 * token — so there is no server-side key cache to keep, and nothing that can go
 * stale between rendering a page and saving a row (convention 6).
 */
export function validateKey(
  input: unknown,
  table: TableFacts,
  row: number,
): ValidatedKey {
  const where: Record<string, unknown> = {}
  const errors: FieldError[] = []

  if (!isRecord(input)) {
    return {
      where,
      errors: [error(row, '', 'not_a_key', 'key must be an object')],
    }
  }

  const wanted = table.identity.cols
  const resolved = new Map<string, unknown>()
  for (const [name, raw] of Object.entries(input)) {
    const column = findColumn(table, name)
    if (!column) {
      errors.push(error(row, name, 'unknown_column', `no column named ${name}`))
      continue
    }
    resolved.set(column.name, raw)
  }

  const missing = wanted.filter(name => !resolved.has(name))
  const extra = [...resolved.keys()].filter(name => !wanted.includes(name))
  if (missing.length || extra.length) {
    errors.push(
      error(
        row,
        [...missing, ...extra].join(', '),
        'key_mismatch',
        `key must name exactly ${wanted.join(', ')}` +
          (missing.length ? `; missing ${missing.join(', ')}` : '') +
          (extra.length ? `; unexpected ${extra.join(', ')}` : ''),
      ),
    )
    return { where, errors }
  }

  for (const name of wanted) {
    const column = table.byName.get(name)!
    const raw = resolved.get(name)
    if (raw === null) {
      // `col = NULL` is never true. A key column that is null is not a key.
      errors.push(
        error(
          row,
          name,
          'null_key',
          `${name} is part of the key and cannot be null`,
        ),
      )
      continue
    }
    coerceInto(where, errors, row, column, raw)
  }

  return { where, errors }
}
