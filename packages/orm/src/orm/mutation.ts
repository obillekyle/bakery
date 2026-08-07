import { throws } from '@bakery/core/utils/common'
import type {
  AppDBOptionals as DBOptionals,
  AppDBSchema as DBSchema,
  AppViews,
} from '../schema-registry'
import { getActiveDb } from '../connection'
import { evalOperands, qId } from '../schema-util'
import { DB } from './query'

export namespace Mutation {
  export type Tables = Exclude<keyof DBSchema, AppViews> | (string & {})
  export type MapOf<T> = Record<string, T>

  export type ValidOptionals<T extends keyof DBSchema> =
    T extends keyof DBOptionals
      ? Extract<DBOptionals[T], keyof DBSchema[T]>
      : never

  export type Prettify<T> = { [K in keyof T]: T[K] } & {}

  /**
   * `RETURNING` takes an identifier list and is interpolated, not bound — the
   * same position `orderBy` and `groupBy` guard with `safeColumn`. It was the
   * one identifier writer on Insert/Update/Delete with no guard at all, so
   * `.returning('* FROM users; DROP TABLE t --')` was emitted verbatim.
   *
   * Validated at the call site rather than in `parse()` so a bad list fails
   * where it was written, which is what `orderBy` does with its direction.
   */
  function safeReturning(cols: string): string {
    return String(cols)
      .split(',')
      .map(part => DB.safeColumn(part.trim()))
      .join(', ')
  }

  export type InsertSchema<T extends Tables> = T extends keyof DBSchema
    ? Prettify<
        Omit<DBSchema[T], ValidOptionals<T>> &
          Partial<Pick<DBSchema[T], ValidOptionals<T>>>
      >
    : MapOf<unknown>

  export type UpdateSchema<T extends Tables> = Partial<InsertSchema<T>>

  export type ColumnTarget<T extends Tables> = T extends keyof DBSchema
    ? keyof DBSchema[T] & string
    : string

  export type QualifiedColumnTarget<T extends Tables> = T extends keyof DBSchema
    ?
        | `${Extract<T, string>}.${Extract<keyof DBSchema[T], string>}`
        | ColumnTarget<T>
    : string



  export interface RunResult {
    lastInsertRowid: number | bigint | null
    changes: number
  }

  export class Insert<T extends Tables = any> {
    constructor(private _table: string) {}
    static into<T extends Tables>(table: T): Insert<T> {
      return new Insert(table as string)
    }

    values(...records: InsertSchema<T>[]): InsertExecutable {
      return new InsertExecutable(this._table, records as MapOf<unknown>[])
    }
  }

  export class InsertExecutable {
    private _returning?: string

    constructor(
      private _table: string,
      private _records: MapOf<unknown>[],
    ) {}

    returning(cols: string = '*'): this {
      this._returning = safeReturning(cols)
      return this
    }

    parse(): { sql: string; params: any[] } {
      if (this._records.length === 0) throws('Empty insert')
      const keySet = new Set<string>()
      for (const record of this._records) {
        for (const key of Object.keys(record)) {
          keySet.add(key)
        }
      }

      const keys = Array.from(keySet)
      const columns = keys.map(k => qId(k)).join(', ')
      const placeholderGroup = `(${Array(keys.length).fill('?').join(', ')})`
      const placeholders = Array(this._records.length)
        .fill(placeholderGroup)
        .join(', ')

      const params = this._records.flatMap(record =>
        keys.map(k => record[k] ?? null),
      )

      const retSql = this._returning ? ` RETURNING ${this._returning}` : ''

      return {
        sql: `INSERT INTO ${qId(this._table)} (${columns}) VALUES ${placeholders}${retSql}`,
        params,
      }
    }

    async array<R = any>(): Promise<R[]> {
      const { sql, params } = this.parse()
      const results = (await getActiveDb()
        .query(sql)
        .all(...params)) as R[]
      return results || []
    }

    async fetch<R = any>(): Promise<R | undefined> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(sql)
        .get(...params)
      return (result as R) || undefined
    }

    first = this.fetch

    async run(): Promise<RunResult> {
      const { sql, params } = this.parse()
      return await getActiveDb()
        .query(sql)
        .run(...params)
    }

    then<TR1 = RunResult, TR2 = never>(
      onf?: ((v: RunResult) => TR1 | PromiseLike<TR1>) | null,
      onr?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.run().then(onf, onr)
    }
  }

  export class Update<T extends Tables = any> {
    constructor(private _table: string) {}
    static table<T extends Tables>(table: T): Update<T> {
      return new Update(table as string)
    }

    set(data: UpdateSchema<T>): UpdateWithWhere<T> {
      return new UpdateWithWhere(this._table, data as MapOf<unknown>)
    }
  }

  export class UpdateWithWhere<T extends Tables = any> {
    constructor(
      private _table: string,
      private _data: MapOf<unknown>,
    ) {}

    where<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): UpdateExecutable<T>
    where(column: any, valueOrRef?: any): UpdateExecutable<T> {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      return new UpdateExecutable(this._table, this._data, parsed)
    }
  }

  export class UpdateExecutable<T extends Tables = any> {
    private _clauses: Array<{
      connector: 'AND' | 'OR'
      left: any
      operator: string
      right: any
      isRightColumn?: boolean
    }> = []

    constructor(
      private _table: string,
      private _data: MapOf<unknown>,
      initialWhere: {
        left: any
        operator: string
        right: any
        isRightColumn?: boolean
      },
    ) {
      this._clauses.push({ connector: 'AND', ...initialWhere })
    }

    and<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): this
    and(column: any, valueOrRef?: any): this {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      this._clauses.push({ connector: 'AND', ...parsed })
      return this
    }

    or<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): this
    or(column: any, valueOrRef?: any): this {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      this._clauses.push({ connector: 'OR', ...parsed })
      return this
    }

    private evalWhere(params: any[]): string {
      const parts: string[] = []
      for (let i = 0; i < this._clauses.length; i++) {
        const c = this._clauses[i]!
        const left = evalOperands(c.left, params, true)
        if (c.operator === '') {
          parts.push(i === 0 ? left : `${c.connector} ${left}`)
        } else {
          const right = evalOperands(c.right, params, c.isRightColumn)
          const clauseStr = `${left} ${c.operator} ${right}`
          parts.push(i === 0 ? clauseStr : `${c.connector} ${clauseStr}`)
        }
      }
      return parts.join(' ')
    }

    private _returning?: string

    returning(cols: string = '*'): this {
      this._returning = safeReturning(cols)
      return this
    }

    parse(): { sql: string; params: any[] } {
      const params: any[] = []
      const setClauses = Object.keys(this._data)
        .map(key => {
          params.push(this._data[key])
          return `${qId(key)} = ?`
        })
        .join(', ')

      const whereSql = this.evalWhere(params)
      const retSql = this._returning ? ` RETURNING ${this._returning}` : ''
      return {
        sql: `UPDATE ${qId(this._table)} SET ${setClauses} WHERE ${whereSql}${retSql}`,
        params,
      }
    }

    async array<R = any>(): Promise<R[]> {
      const { sql, params } = this.parse()
      const results = (await getActiveDb()
        .query(sql)
        .all(...params)) as R[]
      return results || []
    }

    async fetch<R = any>(): Promise<R | undefined> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(sql)
        .get(...params)
      return (result as R) || undefined
    }

    first = this.fetch

    async exists(): Promise<boolean> {
      const params: any[] = []
      const whereSql = this.evalWhere(params)
      const result = await getActiveDb()
        .query(
          `SELECT 1 FROM ${qId(this._table)} WHERE ${whereSql} LIMIT 1`,
        )
        .get(...params)
      return !!result
    }

    async run(): Promise<RunResult> {
      const { sql, params } = this.parse()
      return await getActiveDb()
        .query(sql)
        .run(...params)
    }

    then<TR1 = RunResult, TR2 = never>(
      onf?: ((v: RunResult) => TR1 | PromiseLike<TR1>) | null,
      onr?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.run().then(onf, onr)
    }
  }

  export class Delete<T extends Tables = any> {
    constructor(private _table: string) {}
    static from<T extends Tables>(table: T): Delete<T> {
      return new Delete(table as string)
    }

    where<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): DeleteExecutable<T>
    where(column: any, valueOrRef?: any): DeleteExecutable<T> {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      return new DeleteExecutable(this._table, parsed)
    }
  }

  export class DeleteExecutable<T extends Tables = any> {
    private _returning?: string

    private _clauses: Array<{
      connector: 'AND' | 'OR'
      left: any
      operator: string
      right: any
      isRightColumn?: boolean
    }> = []

    constructor(
      private _table: string,
      initialWhere: {
        left: any
        operator: string
        right: any
        isRightColumn?: boolean
      },
    ) {
      this._clauses.push({ connector: 'AND', ...initialWhere })
    }

    returning(cols: string = '*'): this {
      this._returning = safeReturning(cols)
      return this
    }

    and<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): this
    and(column: any, valueOrRef?: any): this {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      this._clauses.push({ connector: 'AND', ...parsed })
      return this
    }

    or<C extends QualifiedColumnTarget<T>>(
      column: C,
      valueOrRef?: DB.WhereValue<QualifiedColumnTarget<T>>,
    ): this
    or(column: any, valueOrRef?: any): this {
      const parsed = DB.parseWhereArgs(column, valueOrRef)
      this._clauses.push({ connector: 'OR', ...parsed })
      return this
    }

    private evalWhere(params: any[]): string {
      const parts: string[] = []
      for (let i = 0; i < this._clauses.length; i++) {
        const c = this._clauses[i]!
        const left = evalOperands(c.left, params, true)
        // `parseWhereArgs` emits `operator: ''` for the one-argument form —
        // `where(DB.raw`…`)` or `where(<subquery>)` — where the left operand
        // is the whole condition and there is no right one. This branch is a
        // copy of `UpdateExecutable.evalWhere` above, which is a copy of
        // `formatClause` in query.ts; it was the copy that never got it. The
        // failure was silent rather than loud: `evalOperands(undefined)` binds
        // rather than throwing, so the clause came out as
        // `(LOWER(email) = ?)  ?` with a stray `undefined` pushed onto
        // `params` *ahead* of every later clause's value, shifting them all.
        if (c.operator === '') {
          parts.push(i === 0 ? left : `${c.connector} ${left}`)
        } else {
          const right = evalOperands(c.right, params, c.isRightColumn)
          const clauseStr = `${left} ${c.operator} ${right}`
          parts.push(i === 0 ? clauseStr : `${c.connector} ${clauseStr}`)
        }
      }
      return parts.join(' ')
    }

    parse(): { sql: string; params: any[] } {
      const params: any[] = []
      const whereSql = this.evalWhere(params)
      const retSql = this._returning ? ` RETURNING ${this._returning}` : ''
      return {
        sql: `DELETE FROM ${qId(this._table)} WHERE ${whereSql}${retSql}`,
        params,
      }
    }

    async array<R = any>(): Promise<R[]> {
      const { sql, params } = this.parse()
      const results = (await getActiveDb()
        .query(sql)
        .all(...params)) as R[]
      return results || []
    }

    async fetch<R = any>(): Promise<R | undefined> {
      const { sql, params } = this.parse()
      const result = await getActiveDb()
        .query(sql)
        .get(...params)
      return (result as R) || undefined
    }

    first = this.fetch

    async exists(): Promise<boolean> {
      const params: any[] = []
      const whereSql = this.evalWhere(params)
      const result = await getActiveDb()
        .query(
          `SELECT 1 FROM ${qId(this._table)} WHERE ${whereSql} LIMIT 1`,
        )
        .get(...params)
      return !!result
    }

    async run(): Promise<RunResult> {
      const { sql, params } = this.parse()
      return await getActiveDb()
        .query(sql)
        .run(...params)
    }

    then<TR1 = RunResult, TR2 = never>(
      onf?: ((v: RunResult) => TR1 | PromiseLike<TR1>) | null,
      onr?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.run().then(onf, onr)
    }
  }
}
