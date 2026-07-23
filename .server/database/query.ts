/** biome-ignore-all lint/correctness/noUnusedPrivateClassMembers: secret access */
/** biome-ignore-all lint/complexity/noBannedTypes: for types */
import { Case } from '@server/utils'
import { throws } from '@server/utils/common'
import type { DBSchema } from '~/schema'
import { buildSQL } from './build-sql'
import { getActiveDb, txStorage } from './connection'
import { Mutation } from './mutation'
import { evalOperands } from './schema-util'

export namespace DB {
  function pushParamsToRoot(node: any, params: any[]) {
    let root = node
    while (root && !root._param) root = root._previous
    if (root?._param) root._param.push(...params)
  }

  export function safeColumn(col: string): string {
    const q = getActiveDb().quoteChar
    const parts = col.split('.')
    return parts
      .map(part => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(part)) {
          throw new Error(`Invalid or unsafe column/table name: ${part}`)
        }
        return `${q}${Case.snake(part)}${q}`
      })
      .join('.')
  }

  export type Tables = keyof DBSchema | (string & {})

  export type TableSchemas = DBSchema & {
    [key: string]: any
  }

  export type ValidAlias<A> = A extends string
    ? A extends ''
      ? never
      : A
    : never

  export type NewTable<
    S extends TableSchemas,
    A extends string | undefined,
    T extends string,
  > =
    ValidAlias<A> extends never ? S : S & Record<ValidAlias<A>, S[T & keyof S]>

  export type ExactlyOne<T> = {
    [K in keyof T]: { [P in K]: T[P] } & { [P in Exclude<keyof T, K>]?: never }
  }[keyof T]

  export type AnyString = string & {}

  export type FilteredGroups<S, J extends string, G> = {
    [Table in keyof S]: Table extends J
      ? Table extends keyof G
        ? Pick<
            S[Table],
            Extract<
              G[Table] extends readonly any[] ? G[Table][number] : G[Table],
              keyof S[Table]
            >
          >
        : S[Table]
      : S[Table]
  }

  export type TakeSelectValues<S, C> = {
    [A in keyof C]: C[A] extends string
      ? ResolveColumnString<S, C[A]>
      : {
          [K in keyof S]: C[A] extends { [P in K]: infer ColName }
            ? ColName extends keyof S[K]
              ? S[K][ColName]
              : never
            : never
        }[keyof S]
  }

  export type TakeSelectMathValues<C> = {
    [K in keyof C]: number
  }

  export type SQLOperators = '=' | '>' | '<' | '>=' | '<=' | '<>'
  export type ValuesOperators = 'IN' | 'NOT IN'

  export type ColumnString<S, J extends string> =
    | `${Extract<J, keyof S>}.${Extract<keyof S[Extract<J, keyof S>], string>}`
    | AnyString

  export type ResolveColumnString<S, T extends string> =
    T extends `${infer Table}.${infer Col}`
      ? Table extends keyof S
        ? Col extends keyof S[Table]
          ? S[Table][Col]
          : never
        : never
      : never

  export type SQLFuncArg<S, J extends string> =
    | AnyString
    | number
    | ColumnString<S, J>

  export type SQLStringFunctions<S, J extends string> = ExactlyOne<{
    UPPER: SQLFuncArg<S, J>
    LOWER: SQLFuncArg<S, J>
    LENGTH: SQLFuncArg<S, J>
    TRIM: SQLFuncArg<S, J>
    CONCAT: SQLFuncArg<S, J>[]
    SUBSTR: [SQLFuncArg<S, J>, number, number?] | [SQLFuncArg<S, J>, number]
    REPLACE: [SQLFuncArg<S, J>, string, string]
  }>

  export type WhereValue<S, J extends string> =
    | AnyString
    | null
    | number
    | boolean
    | ColumnString<S, J>
    | SQLStringFunctions<S, J>

  export type WhereClause<
    S extends TableSchemas,
    J extends string,
    K = WhereValue<S, J>,
    R = QBWhere<S, J>,
  > = {
    (left: K, operator: SQLOperators, right: K): R
    (left: K, operator: ValuesOperators, right: K[]): R
    (left: K, operator: 'IS' | 'IS NOT', right: K | 'NULL'): R
    (left: K, operator: 'LIKE', right: string | number): R
    (left: K, operator: AnyString, right: K): R
  }

  export type HavingClause<
    F extends FilteredGroups<TableSchemas, any, any>,
    J extends string,
    P,
    R = QBHaving<any, any, F, P>,
    K =
      | ColumnString<F, J>
      | SQLStringFunctions<F, J>
      | keyof P
      | number
      | boolean
      | null
      | AnyString,
  > = {
    (left: K, operator: SQLOperators, right: K): R
    (left: K, operator: ValuesOperators, right: K[]): R
    (left: K, operator: 'IS' | 'IS NOT', right: K | 'NULL'): R
    (left: K, operator: 'LIKE', right: string | number): R
    (left: K, operator: AnyString, right: K): R
  }

  export type SelectMathArgs<F, J extends string, P> = {
    [alias: string]: ExactlyOne<{
      [Op in 'SUM' | 'AVG' | 'MIN' | 'MAX' | 'COUNT']:
        | ColumnString<F, J>
        | keyof P
        | '*'
    }>
  }

  export type SelectColumns<S, J extends string> = {
    [alias: string]: ColumnString<S, J>
  }

  export type CTEAllowed<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any>,
    P,
  > =
    | QBSelectAll<S, J, F, P>
    | QBSelect<S, J, F, P>
    | QBHaving<S, J, F, P>
    | QBOrderBy<S, J, F, P>
    | QBLimit<S, J, F, P>

  export abstract class QBExecutable<P> {
    parse(): { sql: string; params: any[] } {
      return buildSQL(this)
    }

    private mapRow(
      row: MapOf<unknown>,
      rawKeys: string[],
      mappedKeys: string[],
      numKeys: number,
    ): P {
      const mapped: MapOf<unknown> = {}
      for (let i = 0; i < numKeys; i++) {
        mapped[mappedKeys[i]!] = row[rawKeys[i]!]
      }
      return mapped as P
    }

    private mapRowsOptimized(rows: MapOf<unknown>[]): P[] {
      if (!rows || rows.length === 0 || typeof rows[0] !== 'object')
        return rows as any

      const rawKeys = Object.keys(rows[0])
      const numKeys = rawKeys.length
      const mappedKeys = rawKeys.map(k =>
        k.replace(/_([a-z0-9])/gi, (_, letter) => letter.toUpperCase()),
      )
      return rows.map(row =>
        this.mapRow(row as MapOf<unknown>, rawKeys, mappedKeys, numKeys),
      )
    }

    async *iterable(): AsyncIterable<P> {
      const { sql, params } = this.parse()
      let rawKeys: string[] | null = null
      let mappedKeys: string[] | null = null
      let numKeys = 0
      for await (const row of getActiveDb()
        .query(sql)
        .iterate(...(params as unknown[]))) {
        if (typeof row !== 'object') {
          yield row as P
        } else {
          if (!rawKeys) {
            rawKeys = Object.keys(row as object)
            numKeys = rawKeys.length
            mappedKeys = rawKeys.map(k =>
              k.replace(/_([a-z0-9])/gi, (_, letter) => letter.toUpperCase()),
            )
          }
          yield this.mapRow(
            row as MapOf<unknown>,
            rawKeys,
            mappedKeys!,
            numKeys,
          )
        }
      }
    }

    async array(): Promise<P[]> {
      const { sql, params } = this.parse()
      const results = (await getActiveDb()
        .query(sql)
        .all(...(params as unknown[]))) as MapOf<unknown>[]
      return this.mapRowsOptimized(results)
    }

    async column<C = unknown>(): Promise<C[]> {
      const { sql, params } = this.parse()
      const rows = (await getActiveDb()
        .query(sql)
        .values(...(params as unknown[]))) as unknown[][]
      return rows.map((row: unknown[]) => row[0]) as C[]
    }

    async fetch(): Promise<P | undefined> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(sql)
        .get(...(params as unknown[]))
      if (!result) return undefined
      return this.mapRowsOptimized([result])[0]
    }

    first = this.fetch

    then<TR1 = P[], TR2 = never>(
      onfulfilled?: ((v: P[]) => TR1 | PromiseLike<TR1>) | null,
      onrejected?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.array().then(onfulfilled, onrejected)
    }
  }

  export class QBRaw<T = any> extends QBExecutable<T> {
    private _sql: string
    private _params: unknown[]

    constructor(sql: string, params: any[] = []) {
      super()
      this._sql = sql
      this._params = params
    }

    parse(): { sql: string; params: any[] } {
      return { sql: this._sql, params: this._params }
    }
  }

  export class QB<
    S extends TableSchemas = TableSchemas,
    J extends string = never,
  > {
    private _with: Partial<Record<Tables, QB>> = {}
    private _join: Partial<Record<Tables, { alias: string; on: string }>> = {}
    private _table: string = ''
    private _alias: string = ''
    public _param: any[] = []

    private constructor(table: string) {
      this._table = table
    }

    static with<P, N extends string>(
      qb: CTEAllowed<any, any, any, P>,
      name: N,
    ): WithQB<TableSchemas & Record<N, P>, N> {
      const withQB = new (WithQB as any)()
      return withQB.with(qb, name)
    }

    static table<T extends Tables, A extends string | undefined = undefined>(
      name: T,
      as?: A,
    ): QB<
      NewTable<TableSchemas, A, Extract<T, string>>,
      Extract<T, string> | ValidAlias<A>
    > {
      const qb = new QB(name as string)
      qb._alias = as || (name as string)
      return qb as any
    }

    static from = QB.table

    join<
      T extends Extract<keyof S, string>,
      A extends string | undefined = undefined,
    >(
      table: T,
      on: { [K in J]?: keyof S[K] } & {
        [K2 in ValidAlias<A> extends never ? T : ValidAlias<A>]?: keyof S[T]
      },
      as?: A,
    ): QB<NewTable<S, A, T> & S, J | T | ValidAlias<A>> {
      this._join[table as any] = { alias: as || table, on } as any
      return this as any
    }

    where: WhereClause<S, J> = (left: any, operator: any, right: any) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      this._param.push(...params)
      return new (QBWhere as any)(this, ` WHERE ${str}`)
    }

    equals(
      left: ColumnString<S, J> | SQLStringFunctions<S, J>,
      right: WhereValue<S, J>,
    ): QBWhere<S, J> {
      return this.where(left, '=', right)
    }

    select<
      C extends SelectColumns<S, J>,
      P extends TakeSelectValues<FilteredGroups<S, J, {}>, C>,
    >(columns: C): QBSelect<S, J, FilteredGroups<S, J, {}>, P> {
      return new (QBSelect as any)(this, columns)
    }

    selectAll<A extends Extract<J, string>>(
      alias: A,
    ): QBSelectAll<
      S,
      J,
      FilteredGroups<S, J, {}>,
      FilteredGroups<S, J, {}>[A]
    > {
      return new (QBSelectAll as any)(this, alias)
    }
  }

  export class WithQB<S extends TableSchemas, J extends string> {
    private _with: Partial<Record<Tables, QB>> = {}
    private constructor() {}

    with<P, A extends string>(
      qb: CTEAllowed<any, any, any, P>,
      alias: A,
    ): WithQB<S & Record<A, P>, J | A> {
      if (!alias) throws('Name is required')
      ;(this._with as any)[alias] = qb
      return this as any
    }

    table<
      T extends Tables | Extract<keyof S, string>,
      A extends string | undefined = undefined,
    >(
      name: T,
      as?: A,
    ): QB<
      NewTable<S, A, Extract<T, string>>,
      J | Extract<T, string> | ValidAlias<A>
    > {
      const qb = new (QB as any)(name)
      qb._alias = as || name
      qb._with = this._with
      return qb
    }

    from = this.table
  }

  export class QBWhere<S extends TableSchemas, J extends string> {
    private _where: string[] = []
    private _previous: any
    private constructor(query: QB, where: string) {
      this._previous = query
      this._where.push(where)
    }

    and: WhereClause<S, J> = (left: any, operator: any, right: any) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      this._where.push(` AND ${str}`)
      return this
    }

    andEquals(
      left: ColumnString<S, J> | SQLStringFunctions<S, J>,
      right: WhereValue<S, J>,
    ): QBWhere<S, J> {
      return this.and(left, '=', right)
    }

    or: WhereClause<S, J> = (left: any, operator: any, right: any) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      this._where.push(` OR ${str}`)
      return this
    }

    orEquals(
      left: ColumnString<S, J> | SQLStringFunctions<S, J>,
      right: WhereValue<S, J>,
    ): QBWhere<S, J> {
      return this.or(left, '=', right)
    }

    static evalClause(
      LHS: any,
      OPE: string,
      RHS: any,
    ): [string, params: any[]] {
      const params: any[] = []
      const left = evalOperands(LHS, params)
      const right = evalOperands(RHS, params)
      return [`${left} ${OPE} ${right}`, params]
    }

    exists(): Promise<boolean> {
      return new QBExists(this).run()
    }

    then<TResult1 = boolean, TResult2 = never>(
      onfulfilled?:
        | ((value: boolean) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return this.exists().then(onfulfilled, onrejected)
    }

    groupBy<
      G extends ColumnString<S, J>,
      F extends FilteredGroups<S, J, G> = FilteredGroups<S, J, G>,
    >(groups: G): QBGroupBy<S, J, F> {
      const qbGroupBy = new (QBGroupBy as any)(this, '')
      qbGroupBy._groupBy = safeColumn(groups as string)
      return qbGroupBy
    }

    select<
      C extends SelectColumns<S, J>,
      P extends TakeSelectValues<FilteredGroups<S, J, {}>, C>,
    >(columns: C): QBSelect<S, J, FilteredGroups<S, J, {}>, P> {
      return new (QBSelect as any)(this, columns)
    }

    selectAll<A extends Extract<J, string>>(
      alias: A,
    ): QBSelectAll<
      S,
      J,
      FilteredGroups<S, J, {}>,
      FilteredGroups<S, J, {}>[A]
    > {
      return new (QBSelectAll as any)(this, alias)
    }
  }

  export class QBExists {
    private _previous: any
    private _isExistsNode = true
    constructor(previous: any) {
      this._previous = previous
    }

    parse(): { sql: string; params: any[] } {
      return buildSQL(this)
    }

    async run(): Promise<boolean> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(sql)
        .get(...params)
      return !!result
    }
  }

  export class QBGroupBy<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any> = FilteredGroups<S, J, {}>,
  > {
    private _groupBy: string = ''
    private _previous: any
    private constructor(where: QBWhere<S, J> | QB<S, J>, groupBy: string) {
      this._groupBy = groupBy
      this._previous = where
    }

    select<
      C extends SelectColumns<F, J>,
      P extends TakeSelectValues<F, C> = TakeSelectValues<F, C>,
    >(columns: C): QBSelect<S, J, F, P> {
      return new (QBSelect as any)(this, columns)
    }

    selectAll<A extends Extract<J, string>>(
      alias: A,
    ): QBSelectAll<S, J, F, F[A]> {
      return new (QBSelectAll as any)(this, alias)
    }
  }

  export class QBSelectAll<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any> = FilteredGroups<S, J, {}>,
    P = TakeSelectValues<F, {}>,
  > extends QBExecutable<P> {
    public _isSelectNode = true
    public _selectAllAlias?: string
    private _previous: any
    private constructor(previous: any, alias: string) {
      super()
      this._previous = previous
      this._selectAllAlias = alias
    }

    select<
      C extends SelectColumns<F, J>,
      P2 extends TakeSelectValues<F, C> = TakeSelectValues<F, C>,
    >(columns: C): QBSelect<S, J, F, P & P2> {
      return new (QBSelect as any)(this, columns)
    }

    selectMath<
      C extends SelectMathArgs<S, J, P>,
      M extends TakeSelectMathValues<C> = TakeSelectMathValues<C>,
    >(
      columns: C,
    ): Omit<QBSelect<S, J, F, P & M>, 'selectMath' | 'SELECT_MATH'> {
      const qb = new (QBSelect as any)(this, {})
      qb._selectFunctions = columns
      return qb as any
    }

    having: HavingClause<F, J, P, QBHaving<S, J, F, P>> = (
      left: any,
      operator: any,
      right: any,
    ) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      return new (QBHaving as any)(this, str)
    }

    orderBy(
      column: keyof P | ColumnString<F, J>,
      direction: 'ASC' | 'DESC' = 'ASC',
    ): QBOrderBy<S, J, F, P> {
      const orderStr = safeColumn(String(column))
      return new (QBOrderBy as any)(this, `${orderStr} ${direction}`)
    }

    limit(limit: number, offset?: number): QBLimit<S, J, F, P> {
      return new (QBLimit as any)(this, limit, offset)
    }
  }

  export class QBSelect<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any> = FilteredGroups<S, J, {}>,
    P = TakeSelectValues<F, {}>,
  > extends QBExecutable<P> {
    public _isSelectNode = true
    public _select: SelectColumns<S, J> = {} as any
    public _selectFunctions: SelectMathArgs<S, J, P> = {} as any
    private _previous: any
    private constructor(previous: any, select: any) {
      super()
      this._previous = previous
      this._select = select
    }

    selectMath<
      C extends SelectMathArgs<S, J, P>,
      M extends TakeSelectMathValues<C> = TakeSelectMathValues<C>,
    >(
      columns: C,
    ): Omit<QBSelect<S, J, F, P & M>, 'selectMath' | 'SELECT_MATH'> {
      Object.assign(this._selectFunctions, columns)
      return this as any
    }

    having: HavingClause<F, J, P, QBHaving<S, J, F, P>> = (
      left: any,
      operator: any,
      right: any,
    ) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      return new (QBHaving as any)(this, str)
    }

    orderBy(
      column: keyof P | ColumnString<F, J>,
      direction: 'ASC' | 'DESC' = 'ASC',
    ): QBOrderBy<S, J, F, P> {
      const orderStr = safeColumn(String(column))
      return new (QBOrderBy as any)(this, `${orderStr} ${direction}`)
    }

    limit(limit: number, offset?: number): QBLimit<S, J, F, P> {
      return new (QBLimit as any)(this, limit, offset)
    }
  }

  export class QBHaving<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any> = FilteredGroups<S, J, {}>,
    P = TakeSelectValues<F, {}>,
  > extends QBExecutable<P> {
    private _having: string[] = []
    private _previous: any
    private constructor(select: any, having: string) {
      super()
      this._having.push(having)
      this._previous = select
    }

    and: HavingClause<F, J, P, QBHaving<S, J, F, P>> = (
      left: any,
      operator: any,
      right: any,
    ) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      this._having.push(` AND ${str}`)
      return this as any
    }

    or: HavingClause<F, J, P, QBHaving<S, J, F, P>> = (
      left: any,
      operator: any,
      right: any,
    ) => {
      const [str, params] = QBWhere.evalClause(left, operator, right)
      pushParamsToRoot(this._previous, params)
      this._having.push(` OR ${str}`)
      return this as any
    }

    orderBy(
      column: keyof P | ColumnString<F, J>,
      direction: 'ASC' | 'DESC' = 'ASC',
    ): QBOrderBy<S, J, F, P> {
      const orderStr = safeColumn(String(column))
      return new (QBOrderBy as any)(this, `${orderStr} ${direction}`)
    }

    limit(limit: number, offset?: number): QBLimit<S, J, F, P> {
      return new (QBLimit as any)(this, limit, offset)
    }
  }

  export class QBOrderBy<
    S extends TableSchemas,
    J extends string,
    F extends FilteredGroups<S, J, any>,
    P,
  > extends QBExecutable<P> {
    private _orderBy: string = ''
    private _previous: any
    constructor(having: any, order = 'string') {
      super()
      this._previous = having
      this._orderBy = order
    }

    limit(limit: number, offset?: number): QBLimit<S, J, F, P> {
      return new (QBLimit as any)(this, limit, offset)
    }
  }

  export class QBLimit<
    S extends TableSchemas,
    J extends string,
    _F extends FilteredGroups<S, J, any>,
    P,
  > extends QBExecutable<P> {
    private _limit: number
    private _offset?: number
    private _previous: any
    constructor(previous: any, limit: number, offset?: number) {
      super()
      this._previous = previous
      this._limit = limit
      this._offset = offset
    }
  }

  export const table = QB.table
  export const from = QB.from
  export const include = QB.with

  export const raw = <T = any>(sql: string, params: any[] = []) =>
    new QBRaw<T>(sql, params)

  export const Insert = Mutation.Insert
  export const Update = Mutation.Update
  export const Delete = Mutation.Delete

  export function transaction<T>(callback: () => Promise<T> | T): Promise<T> {
    const activeConn = getActiveDb()
    return activeConn.transaction(
      async (tx: import('./adapters').SQLAdapter) => {
        return await txStorage.run(tx, () => callback())
      },
    )
  }
}
