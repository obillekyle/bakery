import { Case } from '@server/utils'
import { throws } from '@server/utils/common'
import type { DBInfo, DBOptionals, DBSchema } from '~/schema'
import { getActiveDb } from './connection'
import { evalOperands } from './schema-util'

export namespace Mutation {
  export type Tables = Exclude<keyof DBSchema, DBInfo.Views> | (string & {})

  export type ValidOptionals<T extends keyof DBSchema> =
    T extends keyof DBOptionals
      ? Extract<DBOptionals[T], keyof DBSchema[T]>
      : never

  export type Prettify<T> = { [K in keyof T]: T[K] } & {}

  export type InsertSchema<T extends Tables> = T extends keyof DBSchema
    ? Prettify<
        Omit<DBSchema[T], ValidOptionals<T>> &
          Partial<Pick<DBSchema[T], ValidOptionals<T>>>
      >
    : MapOf<unknown>

  export type UpdateSchema<T extends Tables> = Partial<InsertSchema<T>>

  export interface RunResult {
    lastInsertRowid: number | bigint | null
    changes: number
  }

  export class MutationExistsExecutable {
    constructor(
      private sql: string,
      private params: any[],
    ) {}
    async run(): Promise<boolean> {
      const result = await getActiveDb()
        .query(this.sql)
        .get(...this.params)
      return !!result
    }
    then<TR1 = boolean, TR2 = never>(
      onfulfilled?: ((v: boolean) => TR1 | PromiseLike<TR1>) | null,
      onrejected?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.run().then(onfulfilled, onrejected)
    }
  }

  export class Insert<T extends Tables> {
    constructor(private _table: string) {}
    static into<T extends Tables>(table: T): Insert<T> {
      return new Insert(table as string)
    }

    values(...records: InsertSchema<T>[]): InsertExecutable {
      return new InsertExecutable(this._table, records)
    }
  }

  export class InsertExecutable {
    constructor(
      private _table: string,
      private _records: MapOf<unknown>[],
    ) {}
    parse(): { sql: string; params: any[] } {
      if (this._records.length === 0) throws('Empty insert')

      const q = getActiveDb().quoteChar
      const keySet = new Set<string>()
      for (const record of this._records) {
        for (const key of Object.keys(record)) {
          keySet.add(key)
        }
      }

      const keys = Array.from(keySet)

      const columns = keys.map(k => `${q}${Case.snake(k)}${q}`).join(', ')

      const placeholderGroup = `(${Array(keys.length).fill('?').join(', ')})`
      const placeholders = Array(this._records.length).fill(placeholderGroup).join(', ')

      const params = this._records.flatMap(record =>
        keys.map(k => record[k] ?? null),
      )

      return {
        sql: `INSERT INTO ${q}${Case.snake(this._table)}${q} (${columns}) VALUES ${placeholders}`,
        params,
      }
    }

    async run(): Promise<RunResult> {
      return await getActiveDb().insert(this._table, this._records)
    }
    then<TR1 = RunResult, TR2 = never>(
      onf?: ((v: RunResult) => TR1 | PromiseLike<TR1>) | null,
      onr?: ((r: any) => TR2 | PromiseLike<TR2>) | null,
    ): Promise<TR1 | TR2> {
      return this.run().then(onf, onr)
    }
  }

  export class Update<T extends Tables> {
    constructor(private _table: string) {}
    static table<T extends Tables>(table: T): Update<T> {
      return new Update(table as string)
    }
    set(data: UpdateSchema<T>): UpdateWithWhere<T> {
      return new UpdateWithWhere(this._table, data)
    }
  }

  export class UpdateWithWhere<_T extends Tables> {
    constructor(
      private _table: string,
      private _data: MapOf<unknown>,
    ) {}
    where(left: any, operator: string, right: any): UpdateExecutable {
      return new UpdateExecutable(this._table, this._data, {
        left,
        operator,
        right,
      })
    }
  }

  export class UpdateExecutable {
    constructor(
      private _table: string,
      private _data: MapOf<unknown>,
      private _whereClause: any,
    ) {}

    private evalWhere(params: any[]): string {
      const left = evalOperands(this._whereClause.left, params)
      const right = evalOperands(this._whereClause.right, params)
      return `${left} ${this._whereClause.operator} ${right}`
    }

    parse(): { sql: string; params: any[] } {
      const q = getActiveDb().quoteChar
      const params: any[] = []
      const setClauses = Object.keys(this._data)
        .map(key => {
          const value = this._data[key]
          params.push(value)
          return `${q}${Case.snake(key)}${q} = ?`
        })
        .join(', ')

      const whereSql = this.evalWhere(params)
      return {
        sql: `UPDATE ${q}${Case.snake(this._table)}${q} SET ${setClauses} WHERE ${whereSql}`,
        params,
      }
    }

    exists(): MutationExistsExecutable {
      const q = getActiveDb().quoteChar
      const params: any[] = []
      const whereSql = this.evalWhere(params)
      return new MutationExistsExecutable(
        `SELECT 1 FROM ${q}${Case.snake(this._table)}${q} WHERE ${whereSql} LIMIT 1`,
        params,
      )
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

  export class Delete<_T extends Tables> {
    constructor(private _table: string) {}
    static from<T extends Tables>(table: T): Delete<T> {
      return new Delete(table as string)
    }
    where(left: any, operator: string, right: any): DeleteExecutable {
      return new DeleteExecutable(this._table, { left, operator, right })
    }
  }

  export class DeleteExecutable {
    constructor(
      private _table: string,
      private _whereClause: any,
    ) {}

    private evalWhere(): { whereSql: string; params: any[] } {
      const params: any[] = []
      const left = evalOperands(this._whereClause.left, params)
      const right = evalOperands(this._whereClause.right, params)
      return { whereSql: `${left} ${this._whereClause.operator} ${right}`, params }
    }

    parse(): { sql: string; params: any[] } {
      const q = getActiveDb().quoteChar
      const { whereSql, params } = this.evalWhere()
      return {
        sql: `DELETE FROM ${q}${Case.snake(this._table)}${q} WHERE ${whereSql}`,
        params,
      }
    }

    exists(): MutationExistsExecutable {
      const q = getActiveDb().quoteChar
      const { whereSql, params } = this.evalWhere()
      return new MutationExistsExecutable(
        `SELECT 1 FROM ${q}${Case.snake(this._table)}${q} WHERE ${whereSql} LIMIT 1`,
        params,
      )
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
