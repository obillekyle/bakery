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


  export function count<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('COUNT', col)
  }
  export function sum<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('SUM', col)
  }
  export function avg<C extends string = string>(col: C): SQLFunctionRef<C> {
    return new SQLFunctionRef('AVG', col)
  }
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
    | QBRaw

  export type SelectColumns<S extends TableSchemas, J extends string> = {
    [alias: string]: SelectValue<S, J>
  }

  export type TakeSelectValues<S, C> = {
    [A in keyof C]: C[A] extends SQLFunctionRef<infer _Col>
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
      type?: 'INNER' | 'LEFT' | 'RIGHT' | 'CROSS',
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
  }

  export interface IQBSelect<
    S extends TableSchemas,
    J extends string,
    P = any,
  > extends QBObject<P> {
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

      this._joins.push({
        table: targetTable,
        alias: aliasKey,
        on: onClause,
        type: type.toUpperCase(),
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
          if (colRef instanceof SQLFunctionRef) {
            // Interpolated, not bound — same allow-list as the WHERE path.
            const funcName = String(colRef.fnName).toUpperCase()
            if (!SQL_FUNCTIONS.has(funcName)) {
              throws(`Unsupported SQL function: ${colRef.fnName}`)
            }
            const arg = colRef.col
            if (arg === '*') {
              selectParts.push(`${funcName}(*) AS ${qRaw(alias)}`)
            } else if (typeof arg === 'string' && arg.includes('.')) {
              const [tbl, colName] = arg.split('.')
              selectParts.push(
                `${funcName}(${qId(tbl!)}.${qId(colName!)}) AS ${qRaw(alias)}`,
              )
            } else {
              selectParts.push(
                `${funcName}(${qId(arg as string)}) AS ${qRaw(alias)}`,
              )
            }
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
