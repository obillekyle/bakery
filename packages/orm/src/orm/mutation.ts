import { Try } from '@bakery/core/utils'
import { throws } from '@bakery/core/utils/common'
import type {
  AppDBOptionals as DBOptionals,
  AppDBSchema as DBSchema,
  AppViews,
} from '../schema-registry'
import { DEFAULT_MAX_QUERY_PARAMS, type SQLAdapter } from '../adapters'
import { getActiveDb, txStorage } from '../connection'
import { evalOperands, qId } from '../schema-util'
import { DB } from './query'

export namespace Mutation {
  /**
   * What may be written to: a declared table that is not a view.
   *
   * There used to be a `| (string & {})` member here, for autocomplete on the
   * literals while still accepting any string. It also made the rest of the
   * type decorative — `Exclude<…, AppViews>` never rejected anything, so a
   * `DB.Insert.into('some_view')` compiled and failed at the database instead,
   * and so did a typo'd table name.
   *
   * Strict now, and it costs nothing when no schema is registered: `DBSchema`
   * falls back to `MapOf<MapOf<any>>` there, whose `keyof` is `string`, so an
   * unregistered app is exactly as permissive as before. Registering a schema
   * is what opts you in.
   */
  export type Tables = Exclude<keyof DBSchema, AppViews>
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

    /**
     * The rows to insert — as a spread, or as one array.
     *
     * Both forms exist because the variadic signature alone made the obvious
     * call wrong in a way nothing announced: `values(rows)` bound the *array*
     * as a single record, and the only symptom was
     * `table big has no column named 0`. An array is never a record, so the two
     * forms cannot be confused, and anything that is neither — a mixed
     * `values(rows, extra)`, a primitive — is rejected by name rather than
     * turned into columns called `0` and `1`.
     */
    values(records: InsertSchema<T>[]): InsertExecutable
    values(...records: InsertSchema<T>[]): InsertExecutable
    values(
      ...args: (InsertSchema<T> | InsertSchema<T>[])[]
    ): InsertExecutable {
      const records =
        args.length === 1 && Array.isArray(args[0])
          ? (args[0] as InsertSchema<T>[])
          : (args as InsertSchema<T>[])

      for (const record of records) {
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
          throws(
            'values() takes records: values(row), values(rowA, rowB) or ' +
              'values(rows). Got a ' +
              (Array.isArray(record) ? 'nested array' : typeof record) +
              ' — if you meant to pass an array of rows, pass it as the only ' +
              'argument.',
          )
        }
      }

      return new InsertExecutable(this._table, records as MapOf<unknown>[])
    }
  }

  export class InsertExecutable {
    private _returning?: string
    private _conflict?: { cols: string[]; update: string[] | null }

    constructor(
      private _table: string,
      private _records: MapOf<unknown>[],
    ) {}

    returning(cols: string = '*'): this {
      this._returning = safeReturning(cols)
      return this
    }

    /**
     * Insert, or update the row that is already there.
     *
     * `cols` names the unique columns that decide "already there" — a primary
     * key or a unique index. Without an upsert the only way to express this is
     * to check and then branch, which is a **race**: two requests both see no
     * row and both insert.
     *
     *     DB.Insert.into('users').values({ email, name }).upsert(['email'])
     *
     * By default every inserted column except the conflict columns is
     * overwritten. Pass a second argument to narrow that — `upsert(['email'],
     * ['name'])` leaves everything else as it was — or an empty array for
     * insert-if-absent, which becomes `DO NOTHING`.
     *
     * MySQL ignores `cols` because `ON DUPLICATE KEY UPDATE` fires on *any*
     * unique key and takes no conflict target. They are still required, since
     * Postgres and SQLite cannot express the statement without them and a
     * schema that works on one dialect should work on all three.
     */
    upsert(cols: string[], update?: string[]): this {
      if (!cols.length) throws('upsert() needs at least one conflict column')
      this._conflict = { cols, update: update ?? null }
      return this
    }

    /** The column list: every record's keys, unioned, in first-seen order. */
    private columnKeys(): string[] {
      const keySet = new Set<string>()
      for (const record of this._records) {
        for (const key of Object.keys(record)) {
          keySet.add(key)
        }
      }
      return Array.from(keySet)
    }

    /**
     * How many records fit in one statement, under the adapter's ceiling.
     *
     * The ceiling comes from the adapter because only it knows its dialect, but
     * a statement can be *rendered* without a connection — `parse()` is how the
     * tests read the SQL, and the stub adapter in `orm.test.ts` implements two
     * members. An unreachable or silent adapter falls back to the same default
     * the base class publishes rather than making `parse()` require a database.
     */
    private batchSize(columnCount: number): number {
      const declared = Try.return(
        () => Number(getActiveDb().maxQueryParams),
        Number.NaN,
      )
      const ceiling =
        Number.isFinite(declared) && declared > 0
          ? declared
          : DEFAULT_MAX_QUERY_PARAMS
      return Math.max(1, Math.floor(ceiling / Math.max(1, columnCount)))
    }

    private statement(
      records: MapOf<unknown>[],
      keys: string[],
    ): { sql: string; params: any[] } {
      const columns = keys.map(k => qId(k)).join(', ')
      const placeholderGroup = `(${Array(keys.length).fill('?').join(', ')})`
      const placeholders = Array(records.length)
        .fill(placeholderGroup)
        .join(', ')

      const params = records.flatMap(record => keys.map(k => record[k] ?? null))

      const retSql = this._returning ? ` RETURNING ${this._returning}` : ''
      // Rebuilt per batch, not hoisted: each batch is a whole statement, so an
      // upsert whose conflict clause only rode on the first one would upsert
      // 10,922 rows and then raise a unique violation on the next batch.
      const conflictSql = this.conflictClause(keys)

      return {
        sql: `INSERT INTO ${qId(this._table)} (${columns}) VALUES ${placeholders}${conflictSql}${retSql}`,
        params,
      }
    }

    /**
     * The insert as one statement per batch — the form the executors run.
     *
     * A single `INSERT … VALUES (…),(…),…` carries three parameters per row, so
     * it stops being a legal statement somewhere around eleven thousand rows.
     * Past that the drivers do not report a limit, they report a *wrapped*
     * count (`expected 54464 values, received 120000`) or `too many SQL
     * variables`, neither of which names the actual problem. Batching under the
     * adapter's ceiling is the only way `values(rows)` can mean what it reads
     * like for an arbitrary `rows`.
     *
     * The column list is computed once, across every record, so every batch
     * inserts the same columns in the same order — a per-batch union would
     * change the shape of the statement halfway through the insert.
     *
     * **`RETURNING` is accumulated, not refused.** Refusing is the
     * safe-looking option and the wrong one: the batches run sequentially
     * inside one transaction, so concatenating each batch's rows in batch order
     * reproduces the sequence a single statement would have produced. Ordering
     * *within* a batch is whatever the dialect gives — Postgres does not
     * promise `RETURNING` follows `VALUES` order — but that is equally true
     * unchunked, so batching neither adds nor removes a guarantee. Refusing
     * would have cost the main reason to write `.values(rows).returning('id')`
     * at all: getting the generated ids of a bulk import back.
     */
    parseAll(): { sql: string; params: any[] }[] {
      if (this._records.length === 0) throws('Empty insert')
      const keys = this.columnKeys()
      const size = this.batchSize(keys.length)

      if (this._records.length <= size) {
        return [this.statement(this._records, keys)]
      }

      const batches: { sql: string; params: any[] }[] = []
      for (let i = 0; i < this._records.length; i += size) {
        batches.push(this.statement(this._records.slice(i, i + size), keys))
      }
      return batches
    }

    /**
     * The insert as one statement.
     *
     * Throws rather than returning the first batch when the records do not fit
     * in one: a caller holding `{sql, params}` executes it themselves, and
     * quietly handing back a third of their rows is the failure mode this whole
     * change exists to remove. `parseAll()` is the honest answer for that case.
     */
    parse(): { sql: string; params: any[] } {
      const batches = this.parseAll()
      if (batches.length > 1) {
        throws(
          `Insert of ${this._records.length} records needs ${batches.length} ` +
            `statements to stay under the parameter ceiling; parse() returns ` +
            `one. Use run()/array()/fetch(), which batch inside a single ` +
            `transaction, or parseAll() for the statements themselves.`,
        )
      }
      return batches[0]!
    }

    /**
     * Run every batch, in one transaction when there is more than one.
     *
     * The transaction is what keeps a batched insert meaning what the unbatched
     * one meant: all rows or none. It is opened only when a batch boundary
     * exists — one statement is already atomic — and only when the caller is
     * not already inside `DB.transaction`, where the outer transaction is
     * already the atomic unit.
     *
     * That second condition is now an economy rather than a requirement: since
     * `SQLAdapter.transaction` nests through `SAVEPOINT`, wrapping anyway would
     * work. It would just buy a savepoint per bulk insert that can never roll
     * back independently of the transaction enclosing it.
     */
    private async runBatches<R>(
      batches: { sql: string; params: any[] }[],
      each: (db: SQLAdapter, sql: string, params: any[]) => Promise<R>,
    ): Promise<R[]> {
      const exec = async (db: SQLAdapter) => {
        const results: R[] = []
        // Sequential on purpose: they share one connection, and a batch that
        // fails has to leave the ones after it unattempted.
        for (const batch of batches) {
          results.push(await each(db, batch.sql, batch.params))
        }
        return results
      }

      const db = getActiveDb()
      if (batches.length === 1 || txStorage.getStore()) return exec(db)
      return db.transaction(tx => exec(tx))
    }

    // `execute` directly rather than `query(sql).run(...params)`: the
    // statement-level API spreads its parameters as arguments, and a batch
    // carries tens of thousands of them.
    private static all(db: SQLAdapter, sql: string, params: any[]) {
      return Promise.resolve(db.execute.all(sql, params))
    }

    /**
     * The upsert clause, in the dialect of the active connection.
     *
     * Two shapes, not three: Postgres and SQLite share
     * `ON CONFLICT (…) DO UPDATE SET col = excluded.col`, while MySQL spells it
     * `ON DUPLICATE KEY UPDATE col = VALUES(col)` and takes no conflict target
     * at all — it fires on whichever unique key was violated.
     *
     * Every identifier goes through `qId`, and no value is interpolated: the
     * new row's values are already bound as the INSERT's parameters, and both
     * dialects refer back to them by name rather than repeating them.
     */
    private conflictClause(insertedKeys: string[]): string {
      if (!this._conflict) return ''
      const { cols, update } = this._conflict

      // Default: everything inserted except the columns that identify the row.
      const targets = (
        update ?? insertedKeys.filter(k => !cols.includes(k))
      ).filter(k => insertedKeys.includes(k))

      const isMySQL = getActiveDb().driver === 'mysql'

      if (isMySQL) {
        if (!targets.length) {
          // MySQL has no DO NOTHING. Assigning a column to itself is the
          // documented idiom for it and leaves the row untouched.
          const self = qId(cols[0]!)
          return ` ON DUPLICATE KEY UPDATE ${self} = ${self}`
        }
        const sets = targets.map(k => `${qId(k)} = VALUES(${qId(k)})`)
        return ` ON DUPLICATE KEY UPDATE ${sets.join(', ')}`
      }

      const target = cols.map(k => qId(k)).join(', ')
      if (!targets.length) return ` ON CONFLICT (${target}) DO NOTHING`
      const sets = targets.map(k => `${qId(k)} = excluded.${qId(k)}`)
      return ` ON CONFLICT (${target}) DO UPDATE SET ${sets.join(', ')}`
    }

    async array<R = any>(): Promise<R[]> {
      const perBatch = await this.runBatches(
        this.parseAll(),
        InsertExecutable.all,
      )
      // Batch order is insertion order, so the concatenation is the sequence a
      // single statement would have returned.
      return perBatch.flatMap(rows => (rows || []) as R[])
    }

    async fetch<R = any>(): Promise<R | undefined> {
      // Every batch still runs — `fetch()` means "insert, and hand me a row
      // back", not "insert the first batch". `Executor.get` is defined as
      // `all(…)[0]`, so this is the same row it would have produced.
      const rows = await this.array<R>()
      return (rows[0] as R) || undefined
    }

    first = this.fetch

    async run(): Promise<RunResult> {
      const results = await this.runBatches(this.parseAll(), (db, sql, params) =>
        Promise.resolve(db.execute.run(sql, params)),
      )
      if (results.length === 1) return results[0]!

      const changes = results.reduce((n, r) => n + Number(r?.changes ?? 0), 0)
      // `changes` sums, because it answers "how many rows did this insert
      // write". `lastInsertRowid` cannot sum, and the dialects do not even
      // agree what it means for a multi-row insert: SQLite and Postgres report
      // the *last* row's id, MySQL's `insertId` reports the *first* of the
      // block. Taking the matching end of the batched run keeps each dialect's
      // own answer true instead of inventing a third one.
      const pick =
        getActiveDb().driver === 'mysql'
          ? results[0]!
          : results[results.length - 1]!
      return { lastInsertRowid: pick?.lastInsertRowid ?? null, changes }
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
