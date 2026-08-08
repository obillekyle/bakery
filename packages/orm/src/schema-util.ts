import { Case } from '@bakery/core/utils'
import { is, throws } from '@bakery/core/utils/common'
import { quoteIdentifier } from './adapters/base'
import { getActiveDb } from './connection'
import type { ForeignKeyAction } from './sync/types'
import type * as SyncTypes from './sync/types'

export type OmitNever<T> = Pick<
  T,
  { [K in keyof T]: T[K] extends never ? never : K }[keyof T]
>

export type TypeMap = {
  integer: number
  number: number
  string: string & {}
  boolean: boolean
  buffer: Buffer
}

export type DataTypes = keyof TypeMap
export type Defs<T extends keyof TypeMap> =
  | `(${string})`
  | '%dateNow%'
  | TypeMap[T]

export type TableDef<
  T extends DataTypes,
  D extends Defs<T> | null | undefined,
  N extends boolean,
  A extends boolean,
  P extends boolean,
> = OmitNever<{
  type: T
  default: D extends undefined ? never : D extends null ? never : D
  nullable: N extends true ? true : D extends null ? true : never
  autoIncrement: A extends true ? true : never
  primary: P extends true ? true : never
}>

export const dateNow = '%dateNow%'

export type ExtractTableTypes<C, K extends keyof C> = {
  [P in keyof C[K] as P extends '_view' ? never : P]: C[K][P] extends {
    // `_enum` first: an enum column's `type` is `'string'`, so routing it
    // through `TypeMap` would widen `'draft' | 'published'` to `string` and
    // throw away the only reason `Field.Enum` exists over `Field.Varchar`.
    _enum: readonly (infer V)[]
  }
    ? V | (C[K][P] extends { nullable: true } ? null : never)
    : C[K][P] extends { type: infer Type }
      ? Type extends keyof TypeMap
        ? TypeMap[Type] | (C[K][P] extends { nullable: true } ? null : never)
        : any
      : any
}

export type ExtractOptionals<C, T extends keyof C> = {
  [K in keyof C[T]]: K extends '_view'
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

export function old<T extends SyncTypes.ColumnConstraint>(
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
