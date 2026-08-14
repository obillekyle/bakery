/**
 * The filter vocabulary, written once and read by both halves.
 *
 * **Pure, and deliberately in `shared/`** — the client builds filters and the
 * endpoint validates them, and a vocabulary that lived on only one side would
 * drift. Like the rest of `shared/`, this is compiled into the browser bundle,
 * so it imports nothing from `@bakery-framework/*` (see `client/safety.test.ts`).
 *
 * The list mirrors `filterClause` in `packages/orm/src/adapters/base.ts`. That
 * method ends with:
 *
 *   > An operator this dialect does not know is dropped rather than guessed at
 *   > … the caller validates the vocabulary before it gets here.
 *
 * This is that caller. Validating matters more than it looks: a *dropped*
 * filter widens the result set, so a typo'd operator would silently show more
 * rows than were asked for — and the explorer's Delete acts on a selection made
 * from exactly that view. Failing the request is the only safe direction
 * (convention 2).
 */

export type FilterOp =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'starts'
  | 'ends'
  | 'null'
  | 'notnull'

/** In menu order: equality, then ordering, then text, then the two nullary. */
export const FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'starts',
  'ends',
  'null',
  'notnull',
] as const

/**
 * The two operators that bind nothing.
 *
 * `IS NULL` has no parameter, which is the whole reason a filter cannot be
 * modelled as a plain column/value pair — the value input is *hidden* for
 * these rather than ignored, because an input whose contents do nothing is a
 * lie about what the query will do.
 */
const NULLARY: ReadonlySet<string> = new Set<string>(['null', 'notnull'])

export function isFilterOp(value: unknown): value is FilterOp {
  return (
    typeof value === 'string' &&
    (FILTER_OPS as readonly string[]).includes(value)
  )
}

export function opTakesValue(op: FilterOp): boolean {
  return !NULLARY.has(op)
}

/** How a chip reads in the UI. Same order as `FILTER_OPS`. */
export const OP_LABELS: Readonly<Record<FilterOp, string>> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  contains: 'contains',
  starts: 'starts with',
  ends: 'ends with',
  null: 'is NULL',
  notnull: 'is not NULL',
}

/** One filter as the user built it. `value` is unused when the op is nullary. */
export interface Filter {
  column: string
  op: FilterOp
  value: string
}

/** One filter as it crosses the wire. */
export interface WireFilter {
  op: FilterOp
  value?: string
}

export function filter(
  column: string,
  op: FilterOp = 'eq',
  value = '',
): Filter {
  return { column, op, value }
}

/**
 * Filters as `getData` wants them: keyed by column.
 *
 * **The wire shape is a record, so a column can carry only one filter** — the
 * ORM iterates `Object.entries(options.filters)`. Two chips on one column
 * therefore cannot both be sent, and the last one wins rather than the first,
 * because the last is the one the user just touched. `duplicateColumns` exists
 * so the builder can say so out loud instead of quietly dropping half of what
 * is on screen.
 *
 * A value-taking op with an empty value is omitted entirely: that is a chip the
 * user has added but not filled in, and sending `col LIKE '%%'` would match
 * every row while looking like a filter.
 */
export function toWire(filters: readonly Filter[]): Record<string, WireFilter> {
  const wire: Record<string, WireFilter> = {}
  for (const entry of filters) {
    if (!entry.column) continue
    if (!opTakesValue(entry.op)) {
      wire[entry.column] = { op: entry.op }
      continue
    }
    if (entry.value === '') continue
    wire[entry.column] = { op: entry.op, value: entry.value }
  }
  return wire
}

/** Columns named by more than one filter — the ones the wire cannot carry. */
export function duplicateColumns(filters: readonly Filter[]): string[] {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const entry of filters) {
    if (!entry.column) continue
    if (seen.has(entry.column)) twice.add(entry.column)
    seen.add(entry.column)
  }
  return [...twice]
}

export type ParsedFilters =
  | { ok: true; filters: Record<string, WireFilter | string> }
  | { ok: false; error: string }

/**
 * Validate what arrived on the query string.
 *
 * Both forms are accepted, because both are in use: a **bare scalar** means
 * `contains` and is what every caller sent before operators existed, and
 * `{op, value}` is the new one. An unknown operator is an error rather than a
 * dropped clause, for the reason in this module's header.
 */
export function parseFilters(raw: unknown): ParsedFilters {
  if (raw === null || raw === undefined) return { ok: true, filters: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'filters must be an object' }
  }

  const filters: Record<string, WireFilter | string> = {}
  for (const [column, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const parsed = parseOne(column, value)
    if ('error' in parsed) return { ok: false, error: parsed.error }
    if (parsed.filter !== null) filters[column] = parsed.filter
  }
  return { ok: true, filters }
}

function parseOne(
  column: string,
  value: unknown,
): { filter: WireFilter | string | null } | { error: string } {
  // The pre-operator form. An empty string is "no filter", which is what a
  // cleared text box has always sent.
  if (value === null || typeof value !== 'object') {
    if (value === null || value === undefined || value === '') {
      return { filter: null }
    }
    return { filter: String(value) }
  }

  const { op, value: operand } = value as { op?: unknown; value?: unknown }
  if (!isFilterOp(op)) {
    return {
      error: `unknown filter operator ${JSON.stringify(op)} on ${column} — expected one of ${FILTER_OPS.join(', ')}`,
    }
  }
  if (!opTakesValue(op)) return { filter: { op } }
  if (operand === null || operand === undefined || operand === '') {
    return { filter: null }
  }
  return { filter: { op, value: String(operand) } }
}
