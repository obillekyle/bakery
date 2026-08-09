/** biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: secret access */
/** biome-ignore-all lint/complexity/noBannedTypes: for types */
import { Case } from '@bakery/core/utils'
import { throws } from '@bakery/core/utils/common'
import type { AppDBSchema as DBSchema } from '../schema-registry'
import { getActiveDb, txStorage } from '../connection'
import {
  evalOperands,
  isSafeIdentifier,
  qId,
  qRaw,
  col as schemaCol,
  ColumnRef as schemaColumnRef,
  OperatorRef as schemaOperatorRef,
  SQL_FUNCTIONS,
  SQLFunctionRef as schemaSQLFunctionRef,
  WindowRef as schemaWindowRef,
} from '../schema-util'
import { Mutation } from './mutation'

export namespace DB {
  export type MapOf<T> = Record<string, T>

  /**
   * Bound a query that only needs its first row. `.get()` otherwise runs the
   * full query and materializes every row into JS objects before discarding all
   * but one — `first()` on an unfiltered table scanned the whole table.
   */
  function singleRow(sql: string): string {
    return /\bLIMIT\s+\d+/i.test(sql) ? sql : `${sql} LIMIT 1`
  }

  /**
   * Join keywords the builder may emit. `FULL` renders as `FULL JOIN`, which
   * both dialects that have it accept as a synonym for `FULL OUTER JOIN`.
   */
  const JOIN_TYPES = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS'])

  /** LIMIT/OFFSET are interpolated, so they must be real non-negative integers. */
  function toRowCount(value: unknown, label: string): number {
    const n = Math.trunc(Number(value))
    if (!Number.isFinite(n) || n < 0) {
      throws(`Invalid ${label}: ${String(value)}`)
    }
    return n
  }

  export function safeColumn(colStr: string): string {
    if (colStr === '*') return colStr

    // A matched pair of parens used to return the input completely unchecked,
    // so `orderBy('(1) UNION SELECT password FROM users --')` sailed straight
    // into the query. Parse the FN(col) form and validate both halves instead.
    const fnCall = colStr.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)\)\s*$/s)
    if (fnCall) {
      const fnName = fnCall[1]!.toUpperCase()
      if (!SQL_FUNCTIONS.has(fnName)) {
        throw new Error(`Unsupported SQL function: ${fnCall[1]}`)
      }
      const inner = fnCall[2]!.trim()
      return `${fnName}(${inner === '*' ? '*' : safeColumn(inner)})`
    }

    if (colStr.includes('(') || colStr.includes(')')) {
      throw new Error(`Invalid or unsafe column/table name: ${colStr}`)
    }

    return colStr
      .split('.')
      .map(part => {
        if (part === '*') return part
        if (!isSafeIdentifier(part)) {
          throw new Error(`Invalid or unsafe column/table name: ${part}`)
        }
        return qId(part)
      })
      .join('.')
  }

  export type Tables = keyof DBSchema
  export type TableSchemas = DBSchema & { [key: string]: any }
  export type ValidAlias<A> = A extends string
    ? A extends ''
      ? never
      : A
    : never
  export type ExtractTableFromDot<T extends string> =
    T extends `${infer Table}.${infer _Col}` ? Table : T

  export type ResolveTableSchema<S, T extends string> =
    ExtractTableFromDot<T> extends keyof DBSchema
      ? DBSchema[ExtractTableFromDot<T>]
      : ExtractTableFromDot<T> extends keyof S
        ? S[ExtractTableFromDot<T>]
        : any

  export type NewJoinedTable<
    S extends TableSchemas,
    A extends string | undefined,
    T extends string,
  > =
    ValidAlias<A> extends never
      ? Record<ExtractTableFromDot<T>, ResolveTableSchema<S, T>>
      : Record<ValidAlias<A>, ResolveTableSchema<S, T>>

  export type NewJoinedScope<
    J extends string,
    A extends string | undefined,
    T extends string,
  > =
    ValidAlias<A> extends never ? J | ExtractTableFromDot<T> : J | ValidAlias<A>

  export type NewTable<
    S extends TableSchemas,
    A extends string | undefined,
    T extends string,
  > = S & NewJoinedTable<S, A, T>

  export type ColumnString<S, J extends string> =
    | {
        [T in J]: T extends keyof S
          ? `${T}.${Extract<keyof S[T] & string, string>}`
          : T extends keyof DBSchema
            ? `${T}.${Extract<keyof DBSchema[T] & string, string>}`
            : never
      }[J]
    | (J extends keyof S
        ? Extract<keyof S[J] & string, string>
        : J extends keyof DBSchema
          ? Extract<keyof DBSchema[J] & string, string>
          : never)

  export type AllTableColumns<S extends TableSchemas> = {
    [T in keyof DBSchema]: `${T & string}.${Extract<keyof DBSchema[T] & string, string>}`
  }[keyof DBSchema]

  export type WhereValue<C extends string> =
    | schemaOperatorRef<any>
    | schemaColumnRef<C>
    | QBRaw
    | QBObject
    | string
    | number
    | boolean
    | null

  export type WhereColumn<S extends TableSchemas, J extends string> =
    | ColumnString<S, J>
    | SQLFunctionRef<ColumnString<S, J>>
    | QBRaw
    | QBObject

  export type ResolveColumnString<
    S,
    T extends string,
  > = T extends `${infer Table}.${infer Col}`
    ? Table extends keyof S
      ? Col extends keyof S[Table]
        ? S[Table][Col]
        : never
      : never
    : { [K in keyof S]: T extends keyof S[K] ? S[K][T] : never }[keyof S]

  // Defined in schema-util so `evalOperands` can use a real `instanceof`.
  export const SQLFunctionRef = schemaSQLFunctionRef
  export type SQLFunctionRef<C extends string = string> = schemaSQLFunctionRef<C>


  /**
   * `COUNT`, `SUM` and `AVG` also come in a `.distinct` form —
   * `DB.count.distinct('users.city')` emits `COUNT(DISTINCT "users"."city")`.
   *
   * Only these three. `DISTINCT` is legal inside `MIN`/`MAX` on every dialect
   * and cannot change their result, so offering it there would imply an effect
   * that does not exist — the same reason the builder has no per-column
   * `distinct('col')`.
   */
  const aggregate = <N extends string>(fnName: N) =>
    Object.assign(
      <C extends string = string>(col: C): SQLFunctionRef<C> =>
        new SQLFunctionRef(fnName, col),
      {
        distinct: <C extends string = string>(col: C): SQLFunctionRef<C> =>
          new SQLFunctionRef(fnName, col, [], true),
      },
    )

  export const count = aggregate('COUNT')
  export const sum = aggregate('SUM')
  export const avg = aggregate('AVG')
  export function min<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('MIN', col)
  }
  export function max<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('MAX', col)
  }
  export function lower<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('LOWER', col)
  }
  export function upper<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('UPPER', col)
  }
  export function length<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('LENGTH', col)
  }
  export function coalesce<C extends string = string>(
    col: C,
    defaultVal: any,
  ): SQLFunctionRef<C> {
    return new SQLFunctionRef('COALESCE', col, [defaultVal])
  }

  // Defined in schema-util for the same reason as SQLFunctionRef: `evalOperands`
  // needs a real `instanceof`.
  export const WindowRef = schemaWindowRef
  export type WindowRef = schemaWindowRef

  /** `PARTITION BY … ORDER BY …`, for a window. Every field is optional. */
  export interface WindowSpec {
    partitionBy?: string | string[]
    /**
     * `'users.score'` or `'users.score DESC'`. The direction is optional and
     * per column, which is why it is spelled inside the string rather than as
     * a separate field — a window frequently orders by two columns in opposite
     * directions, and one shared flag could not express that.
     */
    orderBy?: string | string[]
  }

  /** Build the inside of `OVER (…)`, with every identifier through safeColumn. */
  function windowSpec(spec: WindowSpec = {}): string {
    const parts: string[] = []
    const list = (v: string | string[] | undefined) =>
      v === undefined ? [] : Array.isArray(v) ? v : [v]

    const partition = list(spec.partitionBy).map(c => safeColumn(c))
    if (partition.length) parts.push(`PARTITION BY ${partition.join(', ')}`)

    const order = list(spec.orderBy).map(entry => {
      // Split the direction off the tail rather than taking a separate
      // argument — `safeColumn` would reject 'score DESC' as an identifier, so
      // the two halves have to be validated apart from each other anyway.
      const m = /^(.*?)\s+(ASC|DESC)$/i.exec(String(entry).trim())
      if (!m) return `${safeColumn(String(entry).trim())} ASC`
      return `${safeColumn(m[1]!.trim())} ${m[2]!.toUpperCase()}`
    })
    if (order.length) parts.push(`ORDER BY ${order.join(', ')}`)

    return parts.join(' ')
  }

  /**
   * An aggregate over a window: `SUM("total") OVER (PARTITION BY "user_id")`.
   *
   * ```ts no-check — illustrative
   * DB.from('orders').select({
   *   runningTotal: DB.over(DB.sum('orders.total'), {
   *     partitionBy: 'orders.userId',
   *     orderBy: 'orders.createdAt',
   *   }),
   * })
   * ```
   *
   * Takes an existing function ref rather than a column, so every aggregate the
   * builder already has — including `DB.count.distinct(…)` — composes with a
   * window without a second set of wrappers.
   */
  export function over(
    fn: SQLFunctionRef<string>,
    spec: WindowSpec = {},
  ): WindowRef {
    return new WindowRef(fn, windowSpec(spec))
  }

  /**
   * The ranking functions, which take no column — the window *is* the argument.
   *
   * Only these three are wrapped by name. The rest of `WINDOW_FUNCTIONS`
   * (`LAG`, `NTILE`, `FIRST_VALUE`, …) take arguments whose meaning differs per
   * function, so they go through `DB.window(name, args, spec)` where the caller
   * says what they mean rather than through eleven near-identical helpers.
   */
  const ranking = (fnName: string) => (spec: WindowSpec = {}): WindowRef =>
    new WindowRef(fnName, windowSpec(spec))

  export const rowNumber = ranking('ROW_NUMBER')
  export const rank = ranking('RANK')
  export const denseRank = ranking('DENSE_RANK')

  /**
   * Any window function by name, with its own arguments.
   *
   * ```ts no-check — illustrative
   * DB.window('LAG', ['orders.total', 1], { orderBy: 'orders.createdAt' })
   * ```
   *
   * The name is checked against `WINDOW_FUNCTIONS` (plus the aggregates) at
   * parse time — it is interpolated, not bound. Arguments go through
   * `evalOperands`, so a bare string binds as a parameter and `DB.col('x')`
   * references a column, exactly as everywhere else in the builder.
   */
  export function window(
    fnName: string,
    args: unknown[] = [],
    spec: WindowSpec = {},
  ): WindowRef {
    return new WindowRef(fnName, windowSpec(spec), args)
  }
  export function abs<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('ABS', col)
  }
  export function concat<C extends string = string>(
    col: C,
    ...rest: any[]
  ): SQLFunctionRef<C> {
    return new SQLFunctionRef('CONCAT', col, rest)
  }

  export function equals<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('=', val, isCol)
  }
  export function eq<R>(val: R): schemaOperatorRef<R> {
    return equals(val)
  }
  export function notEquals<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('<>', val, isCol)
  }
  export function neq<R>(val: R): schemaOperatorRef<R> {
    return notEquals(val)
  }
  export function gt<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('>', val, isCol)
  }
  export function gte<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('>=', val, isCol)
  }
  export function lt<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('<', val, isCol)
  }
  export function lte<R>(val: R): schemaOperatorRef<R> {
    const isCol = val instanceof schemaColumnRef
    return new schemaOperatorRef('<=', val, isCol)
  }
  export function like<R>(val: R): schemaOperatorRef<R> {
    return new schemaOperatorRef('LIKE', val)
  }
  export function ilike<R>(val: R): schemaOperatorRef<R> {
    return new schemaOperatorRef('ILIKE', val)
  }
  export function inList<R>(
    vals: R[] | QBObject,
  ): schemaOperatorRef<R[] | QBObject> {
    return new schemaOperatorRef('IN', vals)
  }
  export function notInList<R>(
    vals: R[] | QBObject,
  ): schemaOperatorRef<R[] | QBObject> {
    return new schemaOperatorRef('NOT IN', vals)
  }
  export function isNull(): schemaOperatorRef<null> {
    return new schemaOperatorRef('IS NULL', null)
  }
  export function isNotNull(): schemaOperatorRef<null> {
    return new schemaOperatorRef('IS NOT NULL', null)
  }
  export function between<R>(minVal: R, maxVal: R): schemaOperatorRef<[R, R]> {
    return new schemaOperatorRef('BETWEEN', [minVal, maxVal])
  }

  export type SelectValue<S extends TableSchemas, J extends string> =
    | ColumnString<S, J>
    | SQLFunctionRef<ColumnString<S, J> | '*'>
    // Unparameterised: a window's columns are validated at construction by
    // `safeColumn`, not by the select's column union. Threading `S`/`J` through
    // would mean typing the spec against the same table set, which reads well
    // until a window orders by a *select alias* — legal SQL, and not a column
    // of any table in scope.
    | WindowRef
    | QBRaw

  export type SelectColumns<S extends TableSchemas, J extends string> = {
    [alias: string]: SelectValue<S, J>
  }

  export type TakeSelectValues<S, C> = {
    // `WindowRef` first: it is checked before `SQLFunctionRef` because a
    // windowed aggregate *contains* one, and the outer expression is what the
    // column's type follows.
    [A in keyof C]: C[A] extends WindowRef
      ? number | null
      : C[A] extends SQLFunctionRef<infer _Col>
        ? C[A]['fnName'] extends 'COUNT'
          ? number
          : number | null
        : C[A] extends QBRaw<infer R>
          ? R
          : C[A] extends string
            ? ResolveColumnString<S, C[A]>
            : any
  }

  /**
   * Memo for `Case.camel` over result-row keys. Every row of every result set
   * is re-cased key by key, so a 1000-row × 8-column query ran `Case.camel`
   * 8000 times over the same eight strings — and `Case.camel` is two regex
   * passes, one with a replacer callback.
   *
   * Capped `Map`, not `LRUCache`, for the reason given on `snakeCache` in
   * schema-util: an LRU `get` re-inserts on every hit and measured far slower
   * than the call it would be caching. Column names are schema-derived, but
   * `DB.raw()` can alias a column to anything, so the bound holds by
   * construction rather than by assumption.
   */
  const CAMEL_CACHE_MAX = 4096
  const camelCache = new Map<string, string>()

  function camelKeyOf(key: string): string {
    const hit = camelCache.get(key)
    if (hit !== undefined) return hit
    const value = Case.camel(key)
    if (camelCache.size >= CAMEL_CACHE_MAX) camelCache.clear()
    camelCache.set(key, value)
    return value
  }

  function toCamelCaseKeys<T>(obj: T): T {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj instanceof Date) return obj
    const res: Record<string, any> = {}
    for (const key of Object.keys(obj)) {
      const val = (obj as any)[key]
      res[key] = val
      const camelKey = camelKeyOf(key)
      if (camelKey !== key) {
        res[camelKey] = val
      }
    }
    return res as T
  }

  export abstract class QBExecutable<P> {
    abstract parse(): { sql: string; params: any[] }

    /**
     * `UNION` — every distinct row from this query and the next.
     *
     * Returns a {@link QBSet}, not `this`. That is the whole shape of the
     * feature: a compound select is not a `SELECT` with an extra clause, it is
     * a different kind of statement whose operands happen to be selects. So
     * `.where()` and `.select()` are gone from the result — they would have to
     * mean "on which branch?" — and what remains is what SQL allows after the
     * last operand: `orderBy`, `limit`, `offset`.
     */
    union<Q>(next: QBExecutable<Q>): QBSet<P> {
      return new QBSet<P>([{ op: null, query: this }, { op: 'UNION', query: next }])
    }

    /** `UNION ALL` — as `union`, keeping duplicates. Cheaper: no dedupe pass. */
    unionAll<Q>(next: QBExecutable<Q>): QBSet<P> {
      return new QBSet<P>([
        { op: null, query: this },
        { op: 'UNION ALL', query: next },
      ])
    }

    /** `INTERSECT` — rows present in both. */
    intersect<Q>(next: QBExecutable<Q>, all = false): QBSet<P> {
      return new QBSet<P>([
        { op: null, query: this },
        { op: all ? 'INTERSECT ALL' : 'INTERSECT', query: next },
      ])
    }

    /** `EXCEPT` — rows in this query that are not in the next. */
    except<Q>(next: QBExecutable<Q>, all = false): QBSet<P> {
      return new QBSet<P>([
        { op: null, query: this },
        { op: all ? 'EXCEPT ALL' : 'EXCEPT', query: next },
      ])
    }

    async *iterable(): AsyncIterable<P> {
      const { sql, params } = this.parse()
      for await (const row of getActiveDb()
        .query(sql)
        .iterate(...(params as unknown[]))) {
        yield toCamelCaseKeys(row as P)
      }
    }

    async array(): Promise<P[]> {
      const { sql, params } = this.parse()
      const results = (await getActiveDb()
        .query(sql)
        .all(...(params as unknown[]))) as MapOf<unknown>[]
      return (results || []).map(toCamelCaseKeys) as P[]
    }

    async column<C = unknown>(): Promise<C[]> {
      const { sql, params } = this.parse()
      const rows = (await getActiveDb()
        .query(sql)
        .values(...(params as unknown[]))) as unknown[][]
      return rows.map((row: unknown[]) => row[0]) as C[]
    }

    async value<C = unknown>(): Promise<C | undefined> {
      const { sql, params } = this.parse()
      const rows = (await getActiveDb()
        .query(singleRow(sql))
        .values(...(params as unknown[]))) as unknown[][]
      if (!rows || rows.length === 0 || rows[0]?.length === 0) return undefined
      return rows[0]![0] as C
    }

    scalar = this.value

    async fetch(): Promise<P | undefined> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(singleRow(sql))
        .get(...(params as unknown[]))
      if (!result) return undefined
      return toCamelCaseKeys(result as P)
    }

    first = this.fetch

    async exists(): Promise<boolean> {
      const { sql, params } = this.parse()
      const existsSql = `SELECT 1 FROM (${sql}) AS ${qRaw('sub')} LIMIT 1`
      const result = await getActiveDb()
        .query(existsSql)
        .get(...params)
      return !!result
    }

    then<TR1 = P[], TR2 = never>(
      onfulfilled?: ((v: P[]) => TR1 | PromiseLike<TR1>) | null,
      onrejected?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.array().then(onfulfilled, onrejected)
    }
  }

  export abstract class QBObject<P = any> extends QBExecutable<P> {
    abstract clone(): this
  }

  export type ExtractTableFromColumn<C extends string> =
    C extends `${infer Table}.${infer _Col}` ? Table : C

  // Stage Interfaces for Method Ordering
  export interface IQBTable<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    join<
      R extends AllTableColumns<S>,
      A extends string | undefined = undefined,
    >(
      leftCol: ColumnString<S, J>,
      rightCol: R,
      as?: A,
      type?: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS',
    ): IQBTable<
      S & NewJoinedTable<S, A, ExtractTableFromColumn<R>>,
      NewJoinedScope<J, A, ExtractTableFromColumn<R>>,
      P
    >

    leftJoin<
      R extends AllTableColumns<S>,
      A extends string | undefined = undefined,
    >(
      leftCol: ColumnString<S, J>,
      rightCol: R,
      as?: A,
    ): IQBTable<
      S & NewJoinedTable<S, A, ExtractTableFromColumn<R>>,
      NewJoinedScope<J, A, ExtractTableFromColumn<R>>,
      P
    >

    rightJoin<
      R extends AllTableColumns<S>,
      A extends string | undefined = undefined,
    >(
      leftCol: ColumnString<S, J>,
      rightCol: R,
      as?: A,
    ): IQBTable<
      S & NewJoinedTable<S, A, ExtractTableFromColumn<R>>,
      NewJoinedScope<J, A, ExtractTableFromColumn<R>>,
      P
    >

    innerJoin<
      R extends AllTableColumns<S>,
      A extends string | undefined = undefined,
    >(
      leftCol: ColumnString<S, J>,
      rightCol: R,
      as?: A,
    ): IQBTable<
      S & NewJoinedTable<S, A, ExtractTableFromColumn<R>>,
      NewJoinedScope<J, A, ExtractTableFromColumn<R>>,
      P
    >

    /**
     * `FULL OUTER JOIN`. Typed like the others, but **MySQL has none** — the
     * runtime refuses there, because a capability the compiler cannot see
     * cannot be expressed in this signature.
     */
    fullJoin<
      R extends AllTableColumns<S>,
      A extends string | undefined = undefined,
    >(
      leftCol: ColumnString<S, J>,
      rightCol: R,
      as?: A,
    ): IQBTable<
      S & NewJoinedTable<S, A, ExtractTableFromColumn<R>>,
      NewJoinedScope<J, A, ExtractTableFromColumn<R>>,
      P
    >

    where(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBWhere<S, J, P>

    groupBy(groupCol: ColumnString<S, J>): IQBGroupBy<S, J, P>

    select<
      C extends SelectColumns<S, J>,
      P2 extends TakeSelectValues<S, C> = TakeSelectValues<S, C>,
    >(
      columns: C,
    ): IQBSelect<S, J, P2>
    selectAll<A extends Extract<J, string>>(
      alias?: A,
    ): IQBSelect<
      S,
      J,
      A extends keyof S ? S[A] : S[keyof S] extends infer Row ? Row : any
    >

    /**
     * Ordering and paging are legal straight off the table — `DB.table('t')
     * .limit(10)` needs no where or select — and always worked at runtime.
     * They were simply missing from this stage of the interface chain.
     */
    orderBy(
      colStr: keyof P | ColumnString<S, J>,
      direction?: 'ASC' | 'DESC',
    ): IQBOrderBy<S, J, P>
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export interface IQBWhere<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    and(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBWhere<S, J, P>
    or(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBWhere<S, J, P>

    groupBy(groupCol: ColumnString<S, J>): IQBGroupBy<S, J, P>
    select<
      C extends SelectColumns<S, J>,
      P2 extends TakeSelectValues<S, C> = TakeSelectValues<S, C>,
    >(
      columns: C,
    ): IQBSelect<S, J, P2>
    selectAll<A extends Extract<J, string>>(
      alias?: A,
    ): IQBSelect<
      S,
      J,
      A extends keyof S ? S[A] : S[keyof S] extends infer Row ? Row : any
    >
    orderBy(
      colStr: keyof P | ColumnString<S, J>,
      direction?: 'ASC' | 'DESC',
    ): IQBOrderBy<S, J, P>
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export interface IQBGroupBy<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    select<
      C extends SelectColumns<S, J>,
      P2 extends TakeSelectValues<S, C> = TakeSelectValues<S, C>,
    >(
      columns: C,
    ): IQBSelect<S, J, P2>
    selectAll<A extends Extract<J, string>>(
      alias?: A,
    ): IQBSelect<
      S,
      J,
      A extends keyof S ? S[A] : S[keyof S] extends infer Row ? Row : any
    >
    having(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBHaving<S, J, P>
    /**
     * `SELECT DISTINCT` — see the runtime method for the semantics.
     *
     * Declared here too, unlike the sibling stages, because this one has no
     * `limit`: `distinct()` was added everywhere `limit` already appeared, and
     * that heuristic silently skipped `groupBy`. It ran fine and stopped
     * typechecking, which is precisely what `fluent.test.ts` exists to catch.
     */
    distinct(): this
  }

  export interface IQBHaving<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    andHaving(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBHaving<S, J, P>
    orHaving(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBHaving<S, J, P>
    orderBy(
      colStr: keyof P | ColumnString<S, J>,
      direction?: 'ASC' | 'DESC',
    ): IQBOrderBy<S, J, P>
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export interface IQBSelect<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    /**
     * Grouping after selecting, which always worked at runtime — clauses are
     * assembled at `parse()`, so call order is irrelevant — and was simply
     * missing from this stage of the chain. The same gap `IQBTable` had for
     * `orderBy`/`limit`, found by writing the query that motivates it:
     * `.select({ n: DB.count.distinct(c) }).groupBy(x).having(…)`.
     */
    groupBy(groupCol: ColumnString<S, J>): IQBGroupBy<S, J, P>
    select<
      C extends SelectColumns<S, J>,
      P2 extends TakeSelectValues<S, C> = TakeSelectValues<S, C>,
    >(
      columns: C,
    ): IQBSelect<S, J, P & P2>
    selectAll<A extends Extract<J, string>>(
      alias?: A,
    ): IQBSelect<
      S,
      J,
      P & (A extends keyof S ? S[A] : S[keyof S] extends infer Row ? Row : any)
    >
    having(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBHaving<S, J, P>

    /**
     * Filtering after projection is ordinary builder usage — the clauses are
     * assembled, not emitted in call order — and worked at runtime already.
     * The projection `P` is preserved, so the row type survives the call.
     */
    where(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBSelect<S, J, P>
    and(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBSelect<S, J, P>
    or(
      column: WhereColumn<S, J>,
      valueOrRef?: WhereValue<ColumnString<S, J>>,
    ): IQBSelect<S, J, P>

    orderBy(
      colStr: keyof P | ColumnString<S, J>,
      direction?: 'ASC' | 'DESC',
    ): IQBOrderBy<S, J, P>
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export interface IQBOrderBy<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    orderBy(
      colStr: keyof P | ColumnString<S, J>,
      direction?: 'ASC' | 'DESC',
    ): IQBOrderBy<S, J, P>
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export interface IQBLimit<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
    /** `SELECT DISTINCT` — see the runtime method for the semantics. */
    distinct(): this
    limit(count: number, offset?: number): IQBLimit<S, J, P>
    paginate(page: number, pageSize: number): IQBLimit<S, J, P>
    /** Cursor pagination — see the implementation for why it is not paginate(). */
    seek(
      column: ColumnString<S, J>,
      cursor: unknown,
      pageSize: number,
      direction?: 'ASC' | 'DESC',
    ): IQBLimit<S, J, P>
  }

  export type SetOperator =
    | 'UNION'
    | 'UNION ALL'
    | 'INTERSECT'
    | 'INTERSECT ALL'
    | 'EXCEPT'
    | 'EXCEPT ALL'

  /**
   * A compound select: two or more queries joined by `UNION` and friends.
   *
   * The emission rules below are not style choices — each one is the only form
   * all three dialects accept, measured against live servers rather than read
   * off a standard:
   *
   * - **Operands are bare, never parenthesised.** MySQL and Postgres take
   *   `(SELECT …) UNION (SELECT …)`; **SQLite rejects it outright** — a
   *   parenthesised select is not a legal operand of a compound there.
   * - **A branch carrying its own `ORDER BY`/`LIMIT` is wrapped as a derived
   *   table** instead. `SELECT id FROM a LIMIT 2 UNION …` is a syntax error on
   *   all three, the parenthesised fix works on two of them, and
   *   `SELECT * FROM (SELECT id FROM a LIMIT 2) AS b0` works on all three. The
   *   alias is required by MySQL and harmless elsewhere.
   * - **`ORDER BY` and `LIMIT` on the set go at the very end**, unwrapped,
   *   where every dialect reads them as applying to the whole compound.
   * - **`INTERSECT ALL` / `EXCEPT ALL` are gated.** MySQL 8.0.31+ and Postgres
   *   have them; SQLite does not, and its message — `near "ALL": syntax error`
   *   — does not say which construct it means.
   */
  export class QBSet<P = any> extends QBExecutable<P> {
    private _orderBy: string[] = []
    private _limit?: number
    private _offset?: number

    constructor(
      private branches: { op: SetOperator | null; query: QBExecutable<any> }[],
    ) {
      super()
    }

    private add(op: SetOperator, next: QBExecutable<any>): QBSet<P> {
      this.branches.push({ op, query: next })
      return this
    }

    // Chaining a third operand extends this set rather than nesting one inside
    // another: `a UNION b UNION c` is flat in SQL and mixed operators are
    // evaluated left to right, which is what a flat list already means.
    override union<Q>(next: QBExecutable<Q>): QBSet<P> {
      return this.add('UNION', next)
    }
    override unionAll<Q>(next: QBExecutable<Q>): QBSet<P> {
      return this.add('UNION ALL', next)
    }
    override intersect<Q>(next: QBExecutable<Q>, all = false): QBSet<P> {
      return this.add(all ? 'INTERSECT ALL' : 'INTERSECT', next)
    }
    override except<Q>(next: QBExecutable<Q>, all = false): QBSet<P> {
      return this.add(all ? 'EXCEPT ALL' : 'EXCEPT', next)
    }

    /**
     * Order the whole compound. The column names an *output* column of the
     * set, so it is the select alias rather than `table.column`.
     */
    orderBy(column: string, direction: 'ASC' | 'DESC' = 'ASC'): this {
      const dir = String(direction).toUpperCase()
      if (dir !== 'ASC' && dir !== 'DESC') {
        throws(`Invalid sort direction: ${direction}`)
      }
      this._orderBy.push(`${safeColumn(column)} ${dir}`)
      return this
    }

    limit(count: number, offset?: number): this {
      this._limit = toRowCount(count, 'limit')
      this._offset =
        offset === undefined ? undefined : toRowCount(offset, 'offset')
      return this
    }

    paginate(page: number, pageSize: number): this {
      return this.limit(Math.max(1, pageSize), (Math.max(1, page) - 1) * Math.max(1, pageSize))
    }

    parse(): { sql: string; params: any[] } {
      if (this.branches.length < 2) {
        throws('A set operation needs at least two queries')
      }
      const db = getActiveDb()
      const params: any[] = []
      const parts: string[] = []

      for (let i = 0; i < this.branches.length; i++) {
        const { op, query } = this.branches[i]!
        if (op) {
          if (op.endsWith(' ALL') && op !== 'UNION ALL' && !db?.supportsSetOperationAll) {
            throws(
              `${op} is not supported by this database. ` +
                `Use ${op.replace(' ALL', '')} instead — it removes duplicates.`,
            )
          }
          parts.push(op)
        }
        const parsed = query.parse()
        params.push(...parsed.params)
        // Only a branch that orders or limits itself needs the wrapper; a plain
        // SELECT is emitted as written, which keeps the common case readable.
        parts.push(
          /\b(ORDER\s+BY|LIMIT)\b/i.test(parsed.sql)
            ? `SELECT * FROM (${parsed.sql}) AS ${qRaw(`bakery_set_${i}`)}`
            : parsed.sql,
        )
      }

      const orderSql =
        this._orderBy.length > 0 ? ` ORDER BY ${this._orderBy.join(', ')}` : ''
      const limitSql =
        this._limit !== undefined
          ? ` LIMIT ${this._limit}${this._offset !== undefined ? ` OFFSET ${this._offset}` : ''}`
          : ''

      return { sql: `${parts.join(' ')}${orderSql}${limitSql}`, params }
    }
  }

  export class QBRaw<T = any> extends QBObject<T> {
    constructor(
      private _sql: string,
      private _params: any[] = [],
    ) {
      super()
    }
    parse(): { sql: string; params: any[] } {
      return { sql: this._sql, params: this._params }
    }
    clone(): this {
      return new QBRaw<T>(this._sql, [...this._params]) as any
    }
  }

  export function parseWhereArgs(left: any, valueOrRef?: any) {
    if (
      left &&
      typeof left === 'object' &&
      typeof left.parse === 'function' &&
      valueOrRef === undefined
    ) {
      return {
        left,
        operator: '',
        right: undefined,
        isRightColumn: false,
      }
    }
    if (valueOrRef instanceof schemaOperatorRef) {
      return {
        left,
        operator: valueOrRef.operator,
        right: valueOrRef.right,
        isRightColumn: Boolean(valueOrRef.isRightColumn),
      }
    }
    return {
      left,
      operator: '=',
      right: valueOrRef,
      isRightColumn: false,
    }
  }

  /**
   * Emit one WHERE/HAVING clause. Captures nothing from the builder — it takes
   * `params` as an argument — so it lives here rather than being re-created as
   * a closure on every `parse()`, which is once per executed query.
   */
  function formatClause(
    leftArg: any,
    operator: string,
    rightArg: any,
    isRightColumn: boolean | undefined,
    params: any[],
  ): string {
    const left = evalOperands(leftArg, params, true)
    if (!operator) {
      return left
    }
    const op = operator.toUpperCase()
    if (op === 'IS NULL' || op === 'IS NOT NULL') {
      return `${left} ${op}`
    }
    if (op === 'BETWEEN' && Array.isArray(rightArg)) {
      const min = evalOperands(rightArg[0], params, false)
      const max = evalOperands(rightArg[1], params, false)
      return `${left} BETWEEN ${min} AND ${max}`
    }
    const right = evalOperands(rightArg, params, isRightColumn)
    return `${left} ${operator} ${right}`
  }

  export class QB<
    S extends TableSchemas = DBSchema,
    J extends string = never,
    P = any,
  >
    extends QBObject<P>
    implements
      IQBTable<S, J, P>,
      IQBWhere<S, J, P>,
      IQBGroupBy<S, J, P>,
      IQBHaving<S, J, P>,
      IQBSelect<S, J, P>,
      IQBOrderBy<S, J, P>,
      IQBLimit<S, J, P>
  {
    private _table = ''
    private _alias = ''
    private _with: Record<string, any> = {}
    private _joins: Array<{
      table: string
      alias: string
      /** Already validated and quoted by `join()`. */
      on: string
      type: string
    }> = []
    private _where: Array<{
      connector: 'WHERE' | 'AND' | 'OR'
      left: any
      operator: string
      right: any
      isRightColumn?: boolean
    }> = []
    private _groupBy: string[] = []
    private _having: Array<{
      connector: 'HAVING' | 'AND' | 'OR'
      left: any
      operator: string
      right: any
      isRightColumn?: boolean
    }> = []
    private _distinct = false
    private _select: Record<string, any> = {}
    private _selectAllAlias?: string
    private _orderBy: string[] = []
    private _limit?: number
    private _offset?: number

    private constructor(table: string) {
      super()
      this._table = table
    }

    clone(): this {
      const qb = new QB(this._table)
      qb._alias = this._alias
      qb._with = { ...this._with }
      qb._joins = this._joins.map(j => ({ ...j }))
      qb._where = this._where.map(w => ({ ...w }))
      qb._groupBy = [...this._groupBy]
      qb._having = this._having.map(h => ({ ...h }))
      qb._distinct = this._distinct
      qb._select = { ...this._select }
      qb._selectAllAlias = this._selectAllAlias
      qb._orderBy = [...this._orderBy]
      qb._limit = this._limit
      qb._offset = this._offset
      return qb as any
    }

    static table<T extends Tables, A extends string | undefined = undefined>(
      name: T,
      as?: A,
    ): IQBTable<
      NewTable<TableSchemas, A, Extract<T, string>>,
      Extract<T, string> | ValidAlias<A>,
      any
    > {
      const qb = new QB(name as string)
      qb._alias = as || (name as string)
      return qb as any
    }

    static from = QB.table

    static with<P, N extends string>(
      qb: QBObject<P>,
      name: N,
    ): WithQB<TableSchemas & Record<N, P>, N> {
      const withQB = new (WithQB as any)()
      return withQB.with(qb, name)
    }

    static count = count
    static sum = sum
    static avg = avg
    static min = min
    static max = max
    static lower = lower
    static upper = upper
    static length = length
    static coalesce = coalesce
    static abs = abs
    static concat = concat

    static equals = equals
    static eq = eq
    static notEquals = notEquals
    static neq = neq
    static gt = gt
    static gte = gte
    static lt = lt
    static lte = lte
    static like = like
    static ilike = ilike
    static inList = inList
    static in = inList
    static notInList = notInList
    static notIn = notInList
    static isNull = isNull
    static isNotNull = isNotNull
    static between = between

    /**
     * Both columns, the joined table and the alias go through the convention-8
     * guards here, at the call site — the same thing `orderBy` and `groupBy`
     * do, and for the same reason: the `ColumnString` union is compile-time
     * only, so a value taken off a request reaches this method as a plain
     * string.
     *
     * It previously concatenated the raw arguments into an ON clause and left
     * `parse()` to run a `word.word` regex over the result, quoting what
     * matched and passing everything else through untouched — so
     * `join("users.id = 1 OR 1=1 UNION SELECT password FROM secrets --", …)`
     * was emitted verbatim.
     */
    join(leftCol: any, rightCol: any, as?: string, type = 'INNER'): any {
      const strLeft = String(leftCol)
      const strRight = String(rightCol)

      const targetTable = strRight.includes('.')
        ? strRight.split('.')[0]!
        : strRight
      const aliasKey = as || targetTable

      const rightColName = strRight.includes('.')
        ? strRight.split('.')[1]!
        : 'id'

      // `parse()` quotes these with `qId`, which only strips the dialect's
      // quote character; the allow-list is what makes them identifiers.
      if (!isSafeIdentifier(targetTable)) {
        throws(`Invalid or unsafe join table: ${targetTable}`)
      }
      if (!isSafeIdentifier(aliasKey)) {
        throws(`Invalid or unsafe join alias: ${aliasKey}`)
      }

      // Always qualified, never the raw argument. An undotted right column
      // means "that table's `id`" — which is what the aliased form already
      // emitted — but the unaliased path passed `strRight` straight through, so
      // `join('teachers.campusId', 'campuses')` produced
      // `ON "teachers"."campus_id" = campuses`: a bare table name in a value
      // position, invalid on every dialect and only discovered at execution.
      // For a dotted argument this rebuilds the identical string.
      const rightSideOn = `${aliasKey}.${rightColName}`

      const onClause = `${safeColumn(strLeft)} = ${safeColumn(rightSideOn)}`

      // The union type is compile-time only and this string is interpolated
      // straight into `${j.type} JOIN`, so it needs the same runtime allow-list
      // `orderBy` gives its direction. Without it, a join type taken off a
      // request was emitted verbatim.
      const joinType = String(type).toUpperCase()
      if (!JOIN_TYPES.has(joinType)) {
        throws(`Invalid join type: ${type}`)
      }
      // Refused at the call site rather than at the server, because MySQL's
      // message for it — "You have an error in your SQL syntax" pointing at the
      // whole statement — says nothing about which construct is unsupported.
      if (joinType === 'FULL' && !getActiveDb()?.supportsFullOuterJoin) {
        throws(
          'FULL OUTER JOIN is not supported by this database (MySQL has no ' +
            'FULL JOIN at all). Express it as a LEFT JOIN unioned with a ' +
            'RIGHT JOIN, or query the two sides separately.',
        )
      }

      this._joins.push({
        table: targetTable,
        alias: aliasKey,
        on: onClause,
        type: joinType,
      })
      return this as any
    }

    leftJoin(leftCol: any, rightCol: any, as?: string): any {
      return this.join(leftCol, rightCol, as, 'LEFT')
    }

    rightJoin(leftCol: any, rightCol: any, as?: string): any {
      return this.join(leftCol, rightCol, as, 'RIGHT')
    }

    innerJoin(leftCol: any, rightCol: any, as?: string): any {
      return this.join(leftCol, rightCol, as, 'INNER')
    }

    /**
     * `FULL OUTER JOIN` — every row from both sides, matched where possible.
     *
     * SQLite (3.39+) and Postgres have it; **MySQL does not**, at any version,
     * so this throws there rather than emitting SQL the server will reject.
     */
    fullJoin(leftCol: any, rightCol: any, as?: string): any {
      return this.join(leftCol, rightCol, as, 'FULL')
    }

    where(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._where.push({
        connector: this._where.length === 0 ? 'WHERE' : 'AND',
        ...parsed,
      })
      return this as any
    }

    and(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._where.push({
        connector: 'AND',
        ...parsed,
      })
      return this as any
    }

    or(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._where.push({
        connector: 'OR',
        ...parsed,
      })
      return this as any
    }

    select(columns: Record<string, any>): any {
      Object.assign(this._select, columns)
      return this as any
    }

    selectAll(alias?: string): any {
      this._selectAllAlias = alias || this._alias || this._table
      return this as any
    }

    groupBy(groupCol: string): any {
      this._groupBy.push(safeColumn(groupCol))
      return this as any
    }

    having(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._having.push({
        connector: this._having.length === 0 ? 'HAVING' : 'AND',
        ...parsed,
      })
      return this as any
    }

    andHaving(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._having.push({
        connector: 'AND',
        ...parsed,
      })
      return this as any
    }

    orHaving(left: any, valueOrRef?: any): any {
      const parsed = parseWhereArgs(left, valueOrRef)
      this._having.push({
        connector: 'OR',
        ...parsed,
      })
      return this as any
    }

    orderBy(colStr: any, direction: 'ASC' | 'DESC' = 'ASC'): any {
      // The union type is compile-time only; a value off a request would
      // otherwise be interpolated straight into ORDER BY.
      const dir = String(direction).toUpperCase()
      if (dir !== 'ASC' && dir !== 'DESC') {
        throws(`Invalid sort direction: ${direction}`)
      }
      this._orderBy.push(`${safeColumn(colStr)} ${dir}`)
      return this as any
    }

    /**
     * `SELECT DISTINCT`. Applies to the whole select list, not one column —
     * SQL has no per-column distinct, and offering one would imply otherwise.
     *
     * Idempotent, so `.distinct().distinct()` is one keyword rather than two.
     */
    distinct(): any {
      this._distinct = true
      return this as any
    }

    limit(count: number, offset?: number): any {
      // Coerced here rather than at parse time so a bad value fails at the
      // call site instead of emitting `LIMIT NaN`.
      this._limit = toRowCount(count, 'limit')
      this._offset = offset === undefined ? undefined : toRowCount(offset, 'offset')
      return this as any
    }

    paginate(page: number, pageSize: number): any {
      const p = Math.max(1, page)
      const ps = Math.max(1, pageSize)
      return this.limit(ps, (p - 1) * ps)
    }

    /**
     * Cursor (keyset) pagination — the next `pageSize` rows *after* `cursor`.
     *
     *     const first = await DB.from('posts').seek('id', null, 20).all()
     *     const next  = await DB.from('posts')
     *       .seek('id', first.at(-1)!.id, 20).all()
     *
     * `paginate()` is offset-based, and an offset is not free: `LIMIT 20 OFFSET
     * 200000` makes the server walk and discard 200,000 rows, so page 10,000
     * costs far more than page 1. This walks nothing — it seeks straight into
     * the index — so every page costs the same.
     *
     * It also does not skip or repeat rows when the table is written to
     * mid-scan, which offset paging does by construction: delete one row on
     * page 1 and every later page shifts by one.
     *
     * The trade is that pages are only reachable in order — there is no "jump
     * to page 500" — and the column must be **unique and ordered**, which in
     * practice means a primary key or something monotonic. A non-unique cursor
     * column silently drops the rows that tie on the boundary value, which is
     * why this takes one column rather than pretending to sort by several.
     *
     * `null` or `undefined` means the first page, so the same call site works
     * for both without a branch.
     */
    seek(
      column: string,
      cursor: unknown,
      pageSize: number,
      direction: 'ASC' | 'DESC' = 'ASC',
    ): any {
      const dir = String(direction).toUpperCase()
      if (dir !== 'ASC' && dir !== 'DESC') {
        throws(`Invalid seek direction: ${direction}`)
      }
      // Only after a first page. `seek(col, null, n)` is the opening call and
      // must not become `WHERE col > NULL`, which matches nothing at all.
      if (cursor !== null && cursor !== undefined) {
        // `gt`/`lt`, not a `'id >'` string: the operator belongs in an operand
        // ref, and folding it into the column name puts `id >` through
        // `safeColumn`, which rejects it — correctly, since that is the guard
        // stopping an operator from being smuggled into an identifier.
        this._where.push({
          connector: this._where.length === 0 ? 'WHERE' : 'AND',
          ...parseWhereArgs(column, dir === 'ASC' ? gt(cursor) : lt(cursor)),
        })
      }
      // Ordering is not optional here the way it is for `paginate` — a cursor
      // is meaningless without the order it is a position in. Prepended so an
      // explicit `.orderBy()` still breaks ties after it.
      this._orderBy.unshift(`${safeColumn(column)} ${dir}`)
      return this.limit(pageSize)
    }

    parse(): { sql: string; params: any[] } {
      const params: any[] = []

      // 1. WITH clause
      let withSql = ''
      if (Object.keys(this._with).length > 0) {
        const withParts: string[] = []
        for (const [alias, qb] of Object.entries(this._with)) {
          const parsed = (qb as any).parse()
          withParts.push(`${qRaw(alias)} AS (${parsed.sql})`)
          params.push(...parsed.params)
        }
        withSql = `WITH ${withParts.join(', ')} `
      }

      // 2. SELECT clause
      const selectParts: string[] = []
      if (this._selectAllAlias) {
        selectParts.push(`${qId(this._selectAllAlias)}.*`)
      }

      if (Object.keys(this._select).length > 0) {
        for (const [alias, colRef] of Object.entries(this._select)) {
          if (colRef instanceof WindowRef || colRef instanceof SQLFunctionRef) {
            // `evalOperands` is the single writer for a function call — the
            // same one WHERE and HAVING go through, allow-list included.
            //
            // This used to re-implement it, and the copies had drifted: the
            // select branch never read `extraArgs`, so `COALESCE(col, 'n/a')`
            // emitted `COALESCE("col")` and quietly returned NULL instead of
            // the fallback, while the identical call inside a WHERE was
            // correct. `CONCAT` lost its arguments the same way, and
            // `COUNT(DISTINCT …)` would have been the third.
            selectParts.push(
              `${evalOperands(colRef, params, true)} AS ${qRaw(alias)}`,
            )
          } else if (colRef instanceof QBRaw) {
            const parsedRaw = colRef.parse()
            selectParts.push(`(${parsedRaw.sql}) AS ${qRaw(alias)}`)
            params.push(...parsedRaw.params)
          } else if (typeof colRef === 'string' && colRef.includes('.')) {
            const [tbl, colName] = colRef.split('.')
            selectParts.push(
              `${qId(tbl!)}.${qId(colName!)} AS ${qRaw(alias)}`,
            )
          } else {
            selectParts.push(
              `${qId(colRef)} AS ${qRaw(alias)}`,
            )
          }
        }
      }

      const selectSql = selectParts.length > 0 ? selectParts.join(', ') : '*'

      // 3. FROM clause
      const dbTable = Case.snake(this._table)
      const aliasName = this._alias || this._table
      const fromSql = `FROM ${qRaw(dbTable)}${aliasName !== dbTable ? ` AS ${qId(aliasName)}` : ''}`

      // 4. JOIN clause
      const joinParts: string[] = []
      for (const j of this._joins) {
        // `j.on` is built by `join()` out of `safeColumn` output, so it is
        // already validated and quoted. This used to re-derive it here with a
        // regex, which is where the unguarded write lived.
        joinParts.push(
          `${j.type} JOIN ${qId(j.table)} AS ${qId(j.alias)} ON ${j.on}`,
        )
      }
      const joinSql = joinParts.length > 0 ? ` ${joinParts.join(' ')}` : ''

      // 5. WHERE clause
      let whereSql = ''
      if (this._where.length > 0) {
        const whereParts: string[] = []
        for (let i = 0; i < this._where.length; i++) {
          const w = this._where[i]!
          const clauseStr = formatClause(
            w.left,
            w.operator,
            w.right,
            w.isRightColumn,
            params,
          )
          whereParts.push(i === 0 ? clauseStr : `${w.connector} ${clauseStr}`)
        }
        whereSql = ` WHERE ${whereParts.join(' ')}`
      }

      // 6. GROUP BY clause
      const groupSql =
        this._groupBy.length > 0 ? ` GROUP BY ${this._groupBy.join(', ')}` : ''

      // 7. HAVING clause
      let havingSql = ''
      if (this._having.length > 0) {
        const havingParts: string[] = []
        for (let i = 0; i < this._having.length; i++) {
          const h = this._having[i]!
          const clauseStr = formatClause(
            h.left,
            h.operator,
            h.right,
            h.isRightColumn,
            params,
          )
          havingParts.push(i === 0 ? clauseStr : `${h.connector} ${clauseStr}`)
        }
        havingSql = ` HAVING ${havingParts.join(' ')}`
      }

      // 8. ORDER BY clause
      const orderSql =
        this._orderBy.length > 0 ? ` ORDER BY ${this._orderBy.join(', ')}` : ''

      // 9. LIMIT / OFFSET clause
      const limitSql =
        this._limit !== undefined
          ? ` LIMIT ${this._limit}${this._offset !== undefined ? ` OFFSET ${this._offset}` : ''}`
          : ''

      const distinctSql = this._distinct ? 'DISTINCT ' : ''
      const sql = `${withSql}SELECT ${distinctSql}${selectSql} ${fromSql}${joinSql}${whereSql}${groupSql}${havingSql}${orderSql}${limitSql}`
      return { sql, params }
    }
  }

  export class WithQB<S extends TableSchemas, J extends string> {
    private _with: Record<string, any> = {}
    private constructor() {}

    with<P, A extends string>(
      qb: QBObject<P>,
      alias: A,
    ): WithQB<S & Record<A, P>, J | A> {
      if (!alias) throws('Name is required')
      this._with[alias] = qb
      return this as any
    }

    table<
      T extends Tables | Extract<keyof S, string>,
      A extends string | undefined = undefined,
    >(
      name: T,
      as?: A,
    ): IQBTable<
      NewTable<S, A, Extract<T, string>>,
      J | Extract<T, string> | ValidAlias<A>,
      any
    > {
      const qb = new (QB as any)(name)
      qb._alias = as || name
      qb._with = this._with
      return qb as any
    }

    from = this.table
  }

  export const table = QB.table
  export const from = QB.from
  export const include = QB.with
  export const col: <C extends string>(name: C) => schemaColumnRef<C> =
    schemaCol
  export const cols: <C extends string>(name: C) => schemaColumnRef<C> =
    schemaCol

  export const raw = <T = any>(
    stringsOrSql: string | TemplateStringsArray,
    ...values: any[]
  ) => {
    if (typeof stringsOrSql === 'string') {
      const params =
        values.length > 0 && Array.isArray(values[0]) ? values[0] : values
      return new QBRaw<T>(stringsOrSql, params)
    }
    const strings = stringsOrSql
    let sql = ''
    const params: any[] = []
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i]
      if (i < values.length) {
        const val = values[i]
        if (val instanceof schemaColumnRef) {
          sql += evalOperands(val, params, true)
        } else if (
          typeof val === 'object' &&
          val !== null &&
          typeof (val as any).parse === 'function'
        ) {
          const sub = (val as any).parse()
          sql += sub.sql
          if (sub.params?.length) params.push(...sub.params)
        } else {
          sql += '?'
          params.push(val)
        }
      }
    }
    return new QBRaw<T>(sql, params)
  }

  export const Insert = Mutation.Insert
  export const Update = Mutation.Update
  export const Delete = Mutation.Delete

  export function transaction<T>(
    callback: (tx: import('../adapters').SQLAdapter) => Promise<T> | T,
  ): Promise<T> {
    const activeConn = getActiveDb()
    return activeConn.transaction(
      async (tx: import('../adapters').SQLAdapter) => {
        return await txStorage.run(tx, () => callback(tx))
      },
    )
  }
}
