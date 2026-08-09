import { Case } from '@bakery/core/utils'
import { is, throws } from '@bakery/core/utils/common'
import { quoteIdentifier } from './adapters/base'
import { getActiveDb } from './connection'
import type * as SyncTypes from './sync/types'

export type TypeMap = {
  integer: number
  number: number
  string: string & {}
  boolean: boolean
  buffer: Buffer
}

export type DataTypes = keyof TypeMap

/**
 * A column, described by what it *is* rather than by how it is spelled.
 *
 *     TableDef<number>              // NOT NULL, required on insert
 *     TableDef<string | null, true> // nullable
 *     TableDef<Status, false, true> // an enum, optional on insert
 *
 * Three parameters, where there were five (`type, default, nullable,
 * autoIncrement, primary`). The two that went were positional booleans nothing
 * outside `Field.Primary()` ever set, and `default` was carried only so
 * nullability and optionality could be *derived* from it — which is why
 * "defaulted but not nullable" and "nullable" were indistinguishable to
 * anything downstream.
 *
 * **`T` is the row type, not a dialect name.** `number`, `string | null`, or an
 * enum's own union — so `ExtractTableTypes` is a lookup rather than a mapping
 * through `TypeMap`, and a type `TypeMap` cannot express (an enum, a branded
 * id) needs no special case.
 *
 * At runtime this key holds the dialect discriminator (`'integer'`, `'string'`)
 * that the adapters switch on. The two never meet: every adapter takes
 * `def: unknown` and casts, and the sync engine has its own `ColumnConstraint`,
 * bridged by the cast in `sync/load.ts`. That separation already existed and is
 * what lets this change the schema-facing type without touching a single
 * adapter, generated file, or stored ledger payload.
 */
export type TableDef<
  T,
  N extends boolean = false,
  O extends boolean = false,
> = {
  type: T
  nullable: N
  optional: O
  default?: unknown
  length?: number
  autoIncrement?: boolean
  primary?: boolean
  _enum?: readonly string[]
}

export const dateNow = '%dateNow%'

/**
 * The row type of a column descriptor.
 *
 * Two forms reach here. A `Field.*` builder returns `TableDef<T, …>`, whose
 * `type` **is** the row type, so this is a lookup. A hand-written literal —
 * `{ type: 'integer', default: 0, nullable: true }`, the one shape `Field`
 * does not spell — carries a dialect name there instead, which still goes
 * through `TypeMap`.
 *
 * Distinguished by whether `type` is one of `TypeMap`'s keys. That is
 * unambiguous because those keys are string *literals* and no row type is one:
 * a column of literal type `'integer'` would be `Field.Enum(['integer'])`,
 * whose `type` is the union, not the key.
 */
type RowTypeOf<Col> = Col extends { type: infer T }
  ? T extends keyof TypeMap
    ? TypeMap[T] | (Col extends { nullable: true } ? null : never)
    : T
  : any

export type ExtractTableTypes<C, K extends keyof C> = {
  [P in keyof C[K] as P extends '_view' ? never : P]: RowTypeOf<C[K][P]>
}

/**
 * Which columns may be omitted from an `INSERT`.
 *
 * `optional: true` when a `Field.*` builder said so, which is the whole check
 * for anything `Field` produces — it states optionality rather than leaving it
 * to be reconstructed. The three derived conditions below it are the fallback
 * for a hand-written literal, which has no `optional` key.
 *
 * Stating it also makes a shape expressible that derivation could not:
 * **optional but neither nullable nor defaulted** — a column the database fills
 * in, such as a generated key.
 */
export type ExtractOptionals<C, T extends keyof C> = {
  [K in keyof C[T]]: K extends '_view'
    ? never
    : C[T][K] extends { optional: true }
      ? K
      : C[T][K] extends { optional: false }
        ? never
        : C[T][K] extends { nullable: true }
          ? K
          : C[T][K] extends { default: string | number | boolean | null }
            ? K
            : C[T][K] extends { autoIncrement: true }
              ? K
              : never
}[keyof C[T]]

export type ExtractViews<C> = {
  [K in keyof C]: C[K] extends { _view: string } ? K : never
}[keyof C]

export class ColumnRef<C extends string = string> {
  constructor(public col: C) {}
}

export function col<C extends string>(name: C): ColumnRef<C> {
  return new ColumnRef(name)
}

/**
 * The only SQL function names that may be emitted into a query. `fnName` is
 * interpolated rather than bound, so it must never come from request data.
 */
export const SQL_FUNCTIONS = new Set([
  'ABS',
  'AVG',
  'COALESCE',
  'CONCAT',
  'COUNT',
  'LENGTH',
  'LOWER',
  'MAX',
  'MIN',
  'REPLACE',
  'SUBSTR',
  'SUM',
  'TRIM',
  'UPPER',
])

/**
 * Functions that are only meaningful over a window.
 *
 * Deliberately a second list rather than more entries in `SQL_FUNCTIONS`:
 * `ROW_NUMBER()` outside an `OVER` clause is a syntax error on all three
 * dialects, so putting it in the general list would let the builder emit SQL
 * that cannot run. The aggregates in `SQL_FUNCTIONS` work in *both* positions
 * and stay where they are — `evalOperands` accepts either list inside a window.
 *
 * Verified present on all three servers: SQLite has had window functions since
 * 3.25, MySQL since 8.0, Postgres throughout.
 */
export const WINDOW_FUNCTIONS = new Set([
  'CUME_DIST',
  'DENSE_RANK',
  'FIRST_VALUE',
  'LAG',
  'LAST_VALUE',
  'LEAD',
  'NTH_VALUE',
  'NTILE',
  'PERCENT_RANK',
  'RANK',
  'ROW_NUMBER',
])

/**
 * A function call with an `OVER (…)` clause.
 *
 * `spec` is the inside of the parentheses — `PARTITION BY "a" ORDER BY "b" ASC`
 * — and arrives **already validated and quoted**, exactly like `_joins[].on`.
 * That is deliberate: `safeColumn` lives in the query builder, and duplicating
 * the identifier rules here would make two writers of the same SQL, which is
 * the thing convention 8 exists to prevent. This class stores; the builder
 * validates.
 *
 * No frame clause (`ROWS BETWEEN …`). It is legal everywhere and would fit, but
 * it has its own grammar and nobody has asked — an empty frame is the SQL
 * default and is what every call here gets.
 */
export class WindowRef {
  constructor(
    /** Either an aggregate call, or the name of a window-only function. */
    public fn: SQLFunctionRef | string,
    public spec: string,
    /** Arguments for a window-only function, e.g. `LAG(col, 1)`. */
    public args: unknown[] = [],
  ) {}
}

const RX_SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/** True for a plain identifier safe to interpolate into SQL after quoting. */
export function isSafeIdentifier(name: unknown): name is string {
  return typeof name === 'string' && RX_SAFE_IDENTIFIER.test(name)
}

function activeQuoteChar(): string {
  return getActiveDb()?.quoteChar || '"'
}

/**
 * Memo for `Case.snake`, which is the single most expensive step in quoting an
 * identifier — measurably more than the quoting itself — and is re-run for the
 * same handful of table and column names on every clause of every query.
 *
 * A capped `Map` rather than `LRUCache`: an LRU `get` deletes and re-inserts on
 * every hit to maintain recency, which measured ~38x slower than `Map.get` and
 * would cost more than the `Case.snake` call it is meant to replace. Convention
 * 6 asks for bounded, and this is bounded by construction — identifiers are
 * schema-derived in practice, but `DB.col()` takes a caller-supplied string, so
 * the bound cannot rest on that. Dropping the whole map on overflow is correct
 * because every entry is recomputable: it is a memo, not state.
 */
const SNAKE_CACHE_MAX = 4096
const snakeCache = new Map<string, string>()

function snake(name: string): string {
  const hit = snakeCache.get(name)
  if (hit !== undefined) return hit
  const value = Case.snake(name)
  if (snakeCache.size >= SNAKE_CACHE_MAX) snakeCache.clear()
  snakeCache.set(name, value)
  return value
}

/**
 * Quote an identifier for the active dialect. Everything that interpolates a
 * table/column/alias name goes through here rather than inlining the quote
 * character, so the quote-stripping in `quoteIdentifier` can never be skipped.
 */
export function qRaw(name: string): string {
  return quoteIdentifier(name, activeQuoteChar())
}

/** Quote a single identifier, snake-casing it first. */
export function qId(name: string): string {
  return qRaw(snake(name))
}

/** Quote `table.column`, a bare column, or pass `*` through untouched. */
export function qRef(ref: string): string {
  if (ref === '*') return ref
  const dot = ref.indexOf('.')
  if (dot === -1) return qId(ref)
  return `${qId(ref.slice(0, dot))}.${qId(ref.slice(dot + 1))}`
}

/**
 * Lives here rather than in `orm/query.ts` so `evalOperands` can identify it
 * with a real `instanceof`. It used to be duck-typed on the presence of
 * `fnName`/`col`, which let any JSON request body reach the interpolation below.
 */
export class SQLFunctionRef<C extends string = string> {
  constructor(
    public fnName: string,
    public col: C,
    public extraArgs: any[] = [],
    /**
     * `COUNT(DISTINCT col)` rather than `COUNT(col)`.
     *
     * A property of the call, not of the query: the builder-level `.distinct()`
     * is `SELECT DISTINCT` over the whole row, which is a different thing and
     * composes independently of this one.
     */
    public distinct = false,
  ) {}
}

export class OperatorRef<R = any> {
  constructor(
    public operator: string,
    public right: R,
    public isRightColumn?: boolean,
  ) {}
}

export function evalOperands(
  where: unknown,
  params: unknown[],
  isColumn?: boolean,
): string {
  if (where instanceof ColumnRef) {
    return qRef(where.col)
  }

  if (where instanceof OperatorRef) {
    const op = where.operator.toUpperCase()
    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      return op
    }
    if (op === 'BETWEEN' && Array.isArray(where.right)) {
      const min = evalOperands(where.right[0], params, false)
      const max = evalOperands(where.right[1], params, false)
      return `BETWEEN ${min} AND ${max}`
    }
    if ((op === 'IN' || op === 'NOT IN') && Array.isArray(where.right)) {
      const items = where.right
        .map(v => evalOperands(v, params, false))
        .join(', ')
      return `${op} (${items})`
    }
    const rightSql = evalOperands(
      where.right,
      params,
      where.isRightColumn || where.right instanceof ColumnRef,
    )
    return `${op} ${rightSql}`
  }

  if (Array.isArray(where)) {
    return `(${where.map(v => evalOperands(v, params, isColumn)).join(', ')})`
  }

  if (where === null) return 'NULL'

  if (typeof where === 'object' && where !== null) {
    if (where instanceof WindowRef) {
      // The function half only. `spec` was built by the query builder out of
      // `safeColumn` output and is inserted as-is — see the class comment.
      let call: string
      if (where.fn instanceof SQLFunctionRef) {
        call = evalOperands(where.fn, params, true)
      } else {
        const fnName = String(where.fn).toUpperCase()
        // Interpolated, not bound, so it passes the same kind of allow-list
        // `SQL_FUNCTIONS` applies to an ordinary call.
        if (!WINDOW_FUNCTIONS.has(fnName) && !SQL_FUNCTIONS.has(fnName)) {
          throws(`Unsupported window function: ${where.fn}`)
        }
        const args = where.args
          .map(a => evalOperands(a, params, false))
          .join(', ')
        call = `${fnName}(${args})`
      }
      return `${call} OVER (${where.spec})`
    }

    if (where instanceof SQLFunctionRef) {
      const fnName = String(where.fnName).toUpperCase()
      const colArg = where.col
      const extraArgs = where.extraArgs || []

      // fnName is interpolated, not bound — only known functions may pass.
      if (!SQL_FUNCTIONS.has(fnName)) {
        throws(`Unsupported SQL function: ${where.fnName}`)
      }

      let evalCol = ''
      if (colArg === '*') {
        evalCol = '*'
      } else if (colArg instanceof ColumnRef) {
        evalCol = evalOperands(colArg, params, true)
      } else if (typeof colArg === 'string') {
        evalCol = qRef(colArg)
      } else {
        evalCol = evalOperands(colArg, params, true)
      }

      if (extraArgs.length > 0) {
        const evalExtras = extraArgs
          .map((a: any) => evalOperands(a, params, false))
          .join(', ')
        return `${fnName}(${evalCol}, ${evalExtras})`
      }
      return `${fnName}(${where.distinct ? 'DISTINCT ' : ''}${evalCol})`
    }

    if (typeof (where as any).parse === 'function') {
      const { sql, params: subParams } = (where as any).parse()
      if (subParams && subParams.length > 0) {
        params.push(...subParams)
      }
      return `(${sql})`
    }

    const entries = Object.entries(where)
    if (entries.length === 0) throws('Empty operands object')
    const [key, val] = entries[0]!

    if (SQL_FUNCTIONS.has(key.toUpperCase())) {
      const args = Array.isArray(val) ? val : [val]
      return `${key.toUpperCase()}(${args.map(arg => evalOperands(arg, params, true)).join(', ')})`
    }

    // `{table: 'column'}` becomes a bare identifier reference, so both halves are
    // interpolated. Case.snake does not strip quote characters, so an unchecked
    // value here can break out of the identifier.
    if (!isSafeIdentifier(key) || !isSafeIdentifier(val)) {
      throws(
        `Unsafe identifier in operands object: ${key}.${String(val)}. ` +
          'Pass a scalar to bind it as a parameter.',
      )
    }

    return `${qId(key)}.${qId(val as string)}`
  }

  if (typeof where === 'boolean') return where ? 'TRUE' : 'FALSE'

  if (typeof where === 'string') {
    if (isColumn === true) return qRef(where)

    if (
      isColumn === undefined &&
      /^[a-zA-Z_][a-zA-Z0-9_]*\.[a-zA-Z_][a-zA-Z0-9_]*$/.test(where)
    ) {
      return qRef(where)
    }

    params.push(where)
    return '?'
  }

  params.push(where)
  return '?'
}

export function old<TSchema extends SyncTypes.DBConstraints>(
  oldTableName: string,
  schema: TSchema,
  transform?: (oldRow: Record<string, unknown>) => unknown,
): TSchema

/**
 * Constrained on `{ type: unknown }`, not on `ColumnConstraint`.
 *
 * This is the one function that takes a column descriptor in a *typed*
 * position, so it is where the two vocabularies meet: `ColumnConstraint.type`
 * is the dialect name the sync engine reads, while a `Field.*` builder declares
 * `type` as the **row type**. Requiring the sync-side shape here rejected every
 * `Field` value — `old('title', Field.Varchar(255))` stopped compiling.
 *
 * `old()` only copies the object and adds two keys, so it needs no more than
 * "something with a `type`", and returning `T` unchanged means the row type and
 * optionality survive the wrapper.
 */
export function old<T extends { type: unknown }>(
  oldColumnName: string,
  columnDef: T,
  transform?: (oldValue: unknown, oldRow: Record<string, unknown>) => unknown,
): T

export function old(
  oldName: string,
  target: unknown,
  transform?: unknown,
): unknown {
  if (target && is.object(target) && 'type' in target) {
    return Object.assign({}, target, {
      _oldColumn: oldName,
      _transform: transform,
    })
  }

  return Object.assign({}, target, {
    _oldTable: oldName,
    _transform: transform,
  })
}
