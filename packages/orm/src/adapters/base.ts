import { Bakery } from '@bakery-framework/core/core/bakery'
import { Logger } from '@bakery-framework/core/logger'
import type { MapOf } from '@bakery-framework/core/types'
import { Case, Try } from '@bakery-framework/core/utils'
import { throws } from '@bakery-framework/core/utils/common'
import type * as SyncTypes from '../sync/types'
import { observe, observeIterate } from './observe'
import type { Driver as RegisteredDriver } from './registry'

export namespace SQLAdapter {
  /**
   * Kept as `SQLAdapter.Driver` because that is what the ~40 existing call
   * sites say, but the list itself now lives in `registry.ts` — a namespace
   * member cannot be declaration-merged from another package, and adding a
   * driver has to be possible from outside.
   */
  export type Driver = RegisteredDriver
  export interface RunResult {
    lastInsertRowid: number | bigint | null
    changes: number
  }
  export interface BackupResult {
    file: string
    cleanupCount?: number
  }
  export interface TableColumnInfo {
    name: string
    type: string
    notnull: boolean
    pk: boolean
  }
  export interface TableIndexInfo {
    name: string
    unique: boolean
  }
  export interface TableDetails {
    name: string
    rowCount: number
    columns: TableColumnInfo[]
    indexes: TableIndexInfo[]
  }
  export interface TableDataResult {
    rows: any[]
    totalRows: number
    page: number
    pageSize: number
    totalPages: number
  }
  // `ColumnConstraint` and `IndexConstraint` used to be declared here as well
  // as in `sync/types.ts`, and this copy had fallen behind: no `length`, no
  // `_enum`, no `_oldColumn`/`_transform`, and a `type` union missing `bigint`
  // and `json`. The three sync call sites that cast to it were therefore
  // *erasing* the fields at the exact point they are read — harmless only
  // because `colDef` takes `unknown`. One declaration now, in `sync/types.ts`.

  export type RowRecord = MapOf<any>
  export interface FilterSortOptions {
    sortBy?: string | null
    sortOrder?: string | null
    filters?: MapOf<unknown>
  }
  export interface TableDataOptions extends FilterSortOptions {
    page: number
    pageSize: number
  }
  export interface NameRow {
    name: string
  }
  export interface ColumnNameRow {
    column_name: string
  }
  export interface TableNameRow {
    table_name?: string
  }
  export interface CountRow {
    count: number
  }
  /**
   * The slice of a Bun `SQL` handle that transaction nesting needs.
   *
   * Structural rather than `SQL`, because the base class holds `sql` as
   * `unknown` — each adapter narrows it — and because both members are
   * verified by probe rather than by the type: `savepoint` is present on the
   * root connection and on every transaction and savepoint handle in Bun
   * 1.3.14, on all three dialects.
   */
  export interface TxHandle {
    transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T>
    savepoint<T>(callback: (sp: unknown) => Promise<T>): Promise<T>
  }

  export interface Executor {
    all(sqlText: string, params?: unknown[]): Promise<RowRecord[]> | RowRecord[]
    run(sqlText: string, params?: unknown[]): Promise<RunResult> | RunResult
    iterate(
      sqlText: string,
      params?: unknown[],
    ): AsyncIterable<RowRecord> | Iterable<RowRecord>
    get(sqlText: string, params?: unknown[]): Promise<RowRecord | undefined>
    values(sqlText: string, params?: unknown[]): Promise<unknown[][]>
  }
}

/**
 * The most bound parameters one statement is allowed to carry.
 *
 * A wire-format limit, not a tuning knob. Postgres sends the parameter count as
 * an Int16 and MySQL's prepared-statement protocol does the same, so 65,535 is
 * the hard ceiling on both; SQLite's `SQLITE_MAX_VARIABLE_NUMBER` has been
 * 32,766 since 3.32 and 999 before that.
 *
 * 32,766 for every dialect, deliberately below the two that could go higher.
 * The counter that overflows is 16 bits and it does not *fail* on overflow, it
 * wraps: a 120,000-parameter insert reported `expected 54464 values, received
 * 120000` — 120000 − 65536 — which reads like memory corruption rather than a
 * limit being hit. Half the 16-bit ceiling leaves room for whatever bookkeeping
 * a driver adds on top of the parameters we counted, and the cost of the extra
 * round trips is nothing next to the bytes those parameters weigh.
 */
export const DEFAULT_MAX_QUERY_PARAMS = 32766

/**
 * Is this argument an already-open Bun `SQL` handle rather than a target to
 * open one from?
 *
 * A duck check, because `value instanceof SQL` is unusable: Bun's `SQL` export
 * has no `prototype` property at all — it is `undefined` as of 1.3.14 — and
 * `instanceof` against it does not return false, it **throws**
 * `instanceof called on an object with an invalid prototype property` for every
 * object operand. The MySQL and Postgres constructors read as if they tested
 * this and did not: `instanceof` short-circuits to false for a primitive
 * *before* it touches the right operand, so the string form never reached the
 * throw and the only caller that passes a real handle — `transaction()`,
 * wrapping the connection Bun hands its callback — failed every time it ran.
 *
 * `typeof` covers `function` as well as `object` because a Bun connection is
 * callable: it is the tagged-template entry point, with `unsafe` hung off it.
 */
export function isOpenConnection(value: unknown): boolean {
  return (
    (typeof value === 'function' || typeof value === 'object') &&
    value !== null &&
    typeof (value as { unsafe?: unknown }).unsafe === 'function'
  )
}

export function quoteIdentifier(name: string, quoteChar: string): string {
  // The `includes` guard is not redundant: `replaceAll` walks and rebuilds the
  // string even when there is nothing to replace, and an identifier containing
  // its own dialect's quote character is the rare case, not the common one.
  // This runs for every identifier of every emitted statement.
  return name.includes(quoteChar)
    ? `${quoteChar}${name.replaceAll(quoteChar, '')}${quoteChar}`
    : `${quoteChar}${name}${quoteChar}`
}
/**
 * How many rows one `iterate()` chunk fetches. See {@link pagedIterate}.
 *
 * Big enough that the round trips are amortised, small enough that the point of
 * streaming — never holding the whole result — survives. Not a tuning knob
 * anyone has measured; it is a default, and `createExecutor` takes an override.
 */
export const DEFAULT_STREAM_CHUNK = 500

/**
 * `iterate()`, built out of `all()` by paging.
 *
 * **Bun cannot stream.** As of 1.3.14 an `SQLQuery` is a thenable and nothing
 * more — no `Symbol.asyncIterator`, no `Symbol.iterator`, and its own methods
 * (`raw`, `simple`, `values`, `execute`, `run`) all resolve the whole result.
 * The adapters used to hand their raw query object to `for await`, which is why
 * `iterate` threw `… .iterate is not a function` on **every** dialect and why
 * `QBExecutable.iterable()` had never once worked.
 *
 * So this pages instead: the caller's statement becomes a derived table and the
 * generator walks it a window at a time.
 *
 * ```sql
 * SELECT * FROM (<the caller's SELECT>) AS bakery_stream LIMIT ? OFFSET ?
 * ```
 *
 * Verified on all three dialects against live servers, including a statement
 * that already carries its own `ORDER BY` or `LIMIT` — the derived table
 * contains it, so the window composes rather than colliding. MySQL needs the
 * alias; the other two tolerate it.
 *
 * **What this is not.** It is not a server-side cursor, and the difference is
 * observable, so say it plainly: the statement is re-executed once per chunk,
 * and chunk boundaries are only stable under a total order. Rows inserted or
 * deleted mid-walk can therefore be seen twice or missed — the same hazard
 * offset pagination has, and exactly what `seek()` exists to avoid. What it
 * does buy is the thing people reach for streaming to get: memory bounded by
 * the chunk instead of by the result.
 */
export function pagedIterate(
  all: SQLAdapter.Executor['all'],
  chunkSize: number = DEFAULT_STREAM_CHUNK,
): SQLAdapter.Executor['iterate'] {
  return async function* iterate(sqlText: string, params: unknown[] = []) {
    const derived = `(${sqlText}) AS bakery_stream`
    const windowed = `SELECT * FROM ${derived} LIMIT ? OFFSET ?`
    for (let offset = 0; ; offset += chunkSize) {
      const rows = await all(windowed, [...params, chunkSize, offset])
      for (const row of rows) yield row
      // A short chunk is the end. Checked against the requested size rather
      // than against zero, so the common case costs one round trip fewer than
      // walking until an empty result.
      if (rows.length < chunkSize) return
    }
  }
}

export function createExecutor(
  all: SQLAdapter.Executor['all'],
  run: SQLAdapter.Executor['run'],
  driver: SQLAdapter.Driver,
  options: {
    /** Replace the paging walker — for a driver that can genuinely stream. */
    iterate?: SQLAdapter.Executor['iterate']
    chunkSize?: number
  } = {},
): SQLAdapter.Executor {
  const iterate = options.iterate ?? pagedIterate(all, options.chunkSize)
  // `get` and `values` call the raw `all` rather than `exec.all`, which is a
  // behavioural detail worth stating: it is what keeps one executed statement
  // to exactly one observer event. Routing them through the observed `exec.all`
  // would report every `.get()` twice — once as `get`, once as `all` — and a
  // "slowest queries" panel built on double-counted rows is worse than none.
  return {
    all: observe(driver, 'all', all, rows =>
      Array.isArray(rows) ? rows.length : null,
    ),
    run: observe(driver, 'run', run, result => Number(result?.changes ?? 0)),
    iterate: observeIterate(driver, iterate),
    get: observe(
      driver,
      'get',
      async (sqlText: string, params: unknown[] = []) =>
        (await all(sqlText, params))[0],
      row => (row === undefined ? 0 : 1),
    ),
    values: observe(
      driver,
      'values',
      async (sqlText: string, params: unknown[] = []) =>
        (await all(sqlText, params)).map(Object.values),
      rows => (Array.isArray(rows) ? rows.length : null),
    ),
  }
}

export abstract class SQLAdapter {
  protected abstract sql: unknown
  static readonly DATE_NOW = ''
  readonly DATE_NOW = SQLAdapter.DATE_NOW
  readonly quoteChar: string = '`'

  quote(name: string): string {
    return quoteIdentifier(name, this.quoteChar)
  }

  /**
   * The database this connection is pointed at, or `undefined`.
   *
   * Parsed from the URL rather than asked of the server, because the one caller
   * — normalising a stored view body — runs inside the diff and must not add a
   * round trip to it. SQLite has no such name and needs none: it does not
   * qualify a view's tables in the first place.
   *
   * MySQL writes the schema into every table reference of a stored view, so the
   * body carries a hard-coded database name. Left in, the same schema deployed
   * against a differently-named database compares unequal and the view is
   * recreated on every sync.
   */
  get databaseName(): string | undefined {
    if (!this.url) return undefined
    return Try.return(() => {
      const path = new URL(this.url!).pathname.replace(/^\//, '')
      return path || undefined
    }, undefined)
  }

  /**
   * Placeholder ceiling for a single statement — see
   * {@link DEFAULT_MAX_QUERY_PARAMS} for why it is one number and not three.
   *
   * A getter rather than a field so a dialect that genuinely differs can
   * override it, and so a future adapter can read it off the live server
   * (Postgres exposes nothing for it; SQLite has `sqlite3_limit`).
   */
  get maxQueryParams(): number {
    return DEFAULT_MAX_QUERY_PARAMS
  }

  constructor(
    public readonly driver: SQLAdapter.Driver,
    public readonly filename?: string,
    public readonly url?: string,
  ) {}

  abstract readonly execute: SQLAdapter.Executor
  abstract hasCol(table: string, column: string): Promise<boolean>
  async addCol(table: string, column: string, def: unknown): Promise<void> {
    await this.query(
      `ALTER TABLE ${this.quote(table)}` +
        ` ADD COLUMN ${this.quote(column)} ${this.colDef(def, column)}`,
    ).run()
  }
  abstract colDef(def: unknown, column?: string): string
  abstract backup(keepCount?: number): Promise<SQLAdapter.BackupResult | null>

  /**
   * How deep in `BEGIN` this adapter's handle already is. 0 is a root
   * connection; every level below is a savepoint.
   *
   * Set by {@link transaction} on the child it just built, never by a
   * constructor. Inferring it from "was I handed an open connection?" would be
   * a guess — a pooled handle is open too, and issuing `SAVEPOINT` outside a
   * transaction block is an error on Postgres and a silent no-op on MySQL.
   * Only `transaction` knows for certain, because it is what opened the thing.
   */
  protected transactionDepth = 0

  /**
   * Wrap an already-open connection in a sibling adapter, so a transaction body
   * gets the same API as the connection it came from.
   */
  protected abstract withConnection(sql: unknown): SQLAdapter

  /**
   * Run `callback` atomically — `BEGIN` at the top level, `SAVEPOINT` within an
   * enclosing transaction.
   *
   * The dispatch is the whole point. Bun refuses a nested `BEGIN` outright
   * (`cannot call begin inside a transaction use savepoint() instead`, verbatim
   * on all three dialects), so before this, any two transactional functions
   * that composed — `createUser()` called from `importUsers()`, both perfectly
   * reasonable alone — crashed the moment they met.
   *
   * A failed inner block rolls back to its own savepoint and nothing more, so
   * an outer transaction that catches the error keeps its own work. It only
   * gets the whole thing if it lets the error propagate — which is the same
   * rule a single transaction already follows.
   */
  async transaction<T>(
    callback: (tx: SQLAdapter) => T | Promise<T>,
  ): Promise<T> {
    const handle = this.sql as SQLAdapter.TxHandle
    const run = async (child: unknown): Promise<T> => {
      const tx = this.withConnection(child)
      tx.transactionDepth = this.transactionDepth + 1
      return await callback(tx)
    }
    return this.transactionDepth > 0
      ? await handle.savepoint(run)
      : await handle.transaction(run)
  }
  protected abstract parseConstraints(
    col: unknown,
    ...params: unknown[]
  ): SyncTypes.ColumnConstraint
  abstract getConstraints(): Promise<SyncTypes.DBConstraints>
  abstract getIndexes(): Promise<SyncTypes.DBIndexes>

  /**
   * A table-level `FOREIGN KEY` clause, for inclusion in `CREATE TABLE`.
   *
   * Emitted inline rather than by `ALTER` wherever possible, because SQLite has
   * no `ALTER TABLE ADD FOREIGN KEY` at all — inline is the only spelling all
   * three dialects share.
   */
  foreignKeyClause(fk: SyncTypes.ForeignKeyInfo): string {
    const name = fk.name || SQLAdapter.foreignKeyName(fk)
    const cols = fk.cols.map(c => this.quote(Case.snake(c))).join(', ')
    const refCols = fk.refCols.map(c => this.quote(Case.snake(c))).join(', ')
    // Omitted when NO ACTION: that is the default in every dialect, and every
    // dialect also *reports* it back as NO ACTION, so emitting it explicitly
    // would only add noise to the DDL without changing the read-back.
    const onDelete =
      fk.onDelete && fk.onDelete !== 'NO ACTION'
        ? ` ON DELETE ${fk.onDelete}`
        : ''
    const onUpdate =
      fk.onUpdate && fk.onUpdate !== 'NO ACTION'
        ? ` ON UPDATE ${fk.onUpdate}`
        : ''
    return (
      `CONSTRAINT ${this.quote(name)} FOREIGN KEY (${cols}) ` +
      `REFERENCES ${this.quote(Case.snake(fk.refTable))} (${refCols})` +
      onDelete +
      onUpdate
    )
  }

  /**
   * One spelling for a referential action, whatever the dialect called it.
   *
   * Postgres reports a single character rather than a word; MySQL and SQLite
   * report the word. Anything unrecognised becomes `NO ACTION` — the SQL
   * default — so a dialect that grows a new code cannot make the diff churn.
   */
  static normalizeForeignKeyAction(raw: unknown): SyncTypes.ForeignKeyAction {
    const v = String(raw ?? '')
      .trim()
      .toUpperCase()
    const byChar: Record<string, SyncTypes.ForeignKeyAction> = {
      A: 'NO ACTION',
      R: 'RESTRICT',
      C: 'CASCADE',
      N: 'SET NULL',
      D: 'SET DEFAULT',
    }
    if (v.length === 1 && byChar[v]) return byChar[v]!
    const words: SyncTypes.ForeignKeyAction[] = [
      'NO ACTION',
      'RESTRICT',
      'CASCADE',
      'SET NULL',
      'SET DEFAULT',
    ]
    return words.find(w => w === v) ?? 'NO ACTION'
  }

  /** Deterministic name, so a re-run produces the same constraint. */
  static foreignKeyName(fk: SyncTypes.ForeignKeyInfo): string {
    return `fk_${Case.snake(fk.table)}_${fk.cols.map(Case.snake).join('_')}`
  }

  /**
   * The upsert clause of an `INSERT`: `ON CONFLICT (...) DO UPDATE SET ...`.
   *
   * The SQL-standard spelling, which SQLite and Postgres both take. MySQL uses
   * a different construct entirely and overrides this.
   *
   * `cols` names the unique columns that decide "already there"; `targets` are
   * the columns to overwrite, empty meaning "insert if absent". Both arrive as
   * declared — snake-casing and quoting happen here, so the caller never has to
   * know which dialect it is talking to.
   */
  upsertClause(cols: string[], targets: string[]): string {
    const target = cols.map(c => this.quote(Case.snake(c))).join(', ')
    if (!targets.length) return ` ON CONFLICT (${target}) DO NOTHING`
    const sets = targets.map(k => {
      const q = this.quote(Case.snake(k))
      return `${q} = excluded.${q}`
    })
    return ` ON CONFLICT (${target}) DO UPDATE SET ${sets.join(', ')}`
  }

  /**
   * Which end of a batched multi-row insert `lastInsertRowid` refers to.
   *
   * A large insert is split into batches, so the id has to be taken from one of
   * them — and the dialects do not agree which. SQLite and Postgres report the
   * *last* row written; MySQL's `insertId` reports the *first* of the block.
   * Taking the matching end keeps each dialect's own answer true rather than
   * inventing a third one.
   */
  get batchInsertIdPosition(): 'first' | 'last' {
    return 'last'
  }

  /**
   * Can this dialect attach a foreign key to a table that already exists?
   *
   * SQLite cannot: the constraint is part of the table definition and the only
   * way to add one is to rebuild the table. The planner uses this to choose
   * between an ALTER and a rebuild rather than emitting DDL that fails.
   */
  get supportsAlterForeignKey(): boolean {
    return true
  }

  /**
   * Does a view standing on a table prevent that table from being rebuilt?
   *
   * A rebuild is `CREATE t_temp` → copy → `DROP TABLE t` →
   * `RENAME t_temp TO t`,
   * and two of the three dialects refuse to run it while a view still names `t`
   * — at different steps, and with different messages:
   *
   * - **SQLite** refuses the *rename*: `error in view v: no such table: main.t`
   * - **Postgres** refuses the *drop*: `cannot drop table t because other
   *   objects depend on it`
   * - **MySQL** allows the whole sequence, and the view still reads afterwards:
   *   it resolves a view's tables at query time rather than binding them at
   *   creation.
   *
   * So this is `true` by default and MySQL is the exception — the reverse of
   * how it first reads. Where it holds, the planner drops declared views before
   * the rebuild phase and recreates them a moment later; where it does not, the
   * drop is skipped and the views are simply left alone.
   */
  get viewsBlockTableRebuild(): boolean {
    return true
  }

  /**
   * `INTERSECT ALL` and `EXCEPT ALL` — the duplicate-preserving forms.
   *
   * `UNION ALL` is universal and is not covered by this; only the other two
   * are. MySQL grew them in 8.0.31 and Postgres has always had them; SQLite
   * has neither and reports `near "ALL": syntax error`, which names the
   * keyword but not the construct.
   */
  get supportsSetOperationAll(): boolean {
    return true
  }

  /**
   * `FULL OUTER JOIN`.
   *
   * Postgres has it; SQLite gained it in 3.39 and the version Bun bundles has
   * it. **MySQL has never had it**, at any version — the workaround there is a
   * `LEFT JOIN` unioned with a `RIGHT JOIN`, which is a different query rather
   * than a flag, so the builder refuses instead of rewriting silently.
   */
  get supportsFullOuterJoin(): boolean {
    return true
  }

  async addForeignKey(fk: SyncTypes.ForeignKeyInfo): Promise<void> {
    await this.query(
      `ALTER TABLE ${this.quote(Case.snake(fk.table))}` +
        ` ADD ${this.foreignKeyClause(fk)}`,
    ).run()
  }

  async dropForeignKey(fk: SyncTypes.ForeignKeyInfo): Promise<void> {
    const name = fk.name || SQLAdapter.foreignKeyName(fk)
    await this.query(
      `ALTER TABLE ${this.quote(Case.snake(fk.table))}` +
        ` DROP CONSTRAINT ${this.quote(name)}`,
    ).run()
  }

  abstract getSchema(): Promise<SQLAdapter.TableDetails[]>

  /**
   * Foreign keys as the database has them, keyed by the tuple that identifies
   * one rather than by constraint name.
   *
   * Not abstract: an adapter without an implementation reports "none declared"
   * and the diff simply has nothing to compare, instead of throwing mid-sync.
   */
  async getForeignKeys(): Promise<SyncTypes.DBForeignKeys> {
    return {}
  }

  /**
   * Stable identity for a foreign key: child table, its columns, the parent,
   * its columns.
   *
   * Names are deliberately excluded. SQLite's `PRAGMA foreign_key_list` does
   * not report one, so a name-keyed diff would see every SQLite foreign key as
   * new on every sync — the perpetual-rebuild failure this project has hit
   * repeatedly. The tuple is the same on all three dialects.
   */
  static foreignKeyId(fk: {
    table: string
    cols: string[]
    refTable: string
    refCols: string[]
  }): string {
    const snake = (s: string) => Case.snake(s)
    return [
      snake(fk.table),
      fk.cols.map(snake).join('+'),
      snake(fk.refTable),
      fk.refCols.map(snake).join('+'),
    ].join('->')
  }

  /** Fold one-row-per-column introspection results into one entry per key. */
  static groupForeignKeyRows(rows: any[]): SyncTypes.DBForeignKeys {
    const byName = new Map<string, any>()
    for (const r of rows) {
      const key = String(r.name)
      const g = byName.get(key) ?? {
        table: String(r.child),
        cols: [] as string[],
        refTable: String(r.parent),
        refCols: [] as string[],
        name: key,
        // Normalised here, not at the call site: Postgres reports a single
        // character where MySQL reports a word, and the diff has to compare one
        // vocabulary or it replaces every key on every sync.
        onDelete: SQLAdapter.normalizeForeignKeyAction(r.on_delete),
        onUpdate: SQLAdapter.normalizeForeignKeyAction(r.on_update),
      }
      g.cols.push(String(r.child_col))
      g.refCols.push(String(r.parent_col))
      byName.set(key, g)
    }
    const out: SyncTypes.DBForeignKeys = {}
    for (const fk of byName.values()) out[SQLAdapter.foreignKeyId(fk)] = fk
    return out
  }
  abstract getData(
    table: string,
    opts: SQLAdapter.TableDataOptions,
  ): Promise<SQLAdapter.TableDataResult>
  abstract remove(table: string, rowid: unknown): Promise<SQLAdapter.RunResult>
  abstract truncate(table: string): Promise<SQLAdapter.RunResult>
  async insert(
    table: string,
    rowOrRows: SQLAdapter.RowRecord | SQLAdapter.RowRecord[],
    mapSnake = true,
  ): Promise<SQLAdapter.RunResult> {
    const records = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
    if (!records.length) return { lastInsertRowid: null, changes: 0 }
    const formattedRecords = mapSnake
      ? records.map(r => {
          const keys = Object.keys(r)
          const obj: SQLAdapter.RowRecord = {}
          for (let i = 0; i < keys.length; i++) {
            const k = keys[i]
            obj[Case.snake(k)] = r[k]
          }
          return obj
        })
      : records
    const columnsList = [...new Set(formattedRecords.flatMap(Object.keys))]
    const columns = columnsList.map(k => this.quote(k)).join(', ')
    const placeholderRow = Array(columnsList.length).fill('?').join(', ')
    const placeholderGroup = `(${placeholderRow})`
    const placeholders = Array(formattedRecords.length)
      .fill(placeholderGroup)
      .join(', ')
    const params = formattedRecords.flatMap(r =>
      columnsList.map(k => r[k] ?? null),
    )
    return await this.execute.run(
      `INSERT INTO ${this.quote(Case.snake(table))} (${columns})` +
        ` VALUES ${placeholders}`,
      params,
    )
  }
  abstract update(
    table: string,
    rowid: unknown,
    row: SQLAdapter.RowRecord,
  ): Promise<SQLAdapter.RunResult>

  async drop(
    type: 'TABLE' | 'VIEW' | 'INDEX' | 'COLUMN',
    ...params: string[]
  ): Promise<SQLAdapter.RunResult> {
    if (type === 'COLUMN') {
      return await this.query(
        `ALTER TABLE ${this.quote(params[0])}` +
          ` DROP COLUMN ${this.quote(params[1])}`,
      ).run()
    }
    return await this.query(
      `DROP ${type} IF EXISTS ${this.quote(params[0])}`,
    ).run()
  }
  async rename(
    type: 'TABLE' | 'COLUMN',
    ...params: string[]
  ): Promise<SQLAdapter.RunResult> {
    if (type === 'TABLE') {
      return await this.query(
        `ALTER TABLE ${this.quote(params[0])}` +
          ` RENAME TO ${this.quote(params[1])}`,
      ).run()
    }
    return await this.query(
      `ALTER TABLE ${this.quote(params[0])}` +
        ` RENAME COLUMN ${this.quote(params[1])}` +
        ` TO ${this.quote(params[2])}`,
    ).run()
  }
  async createIndex(
    name: string,
    table: string,
    cols: string[],
    unique = false,
  ): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.quote(name)}` +
        ` ON ${this.quote(table)}` +
        ` (${cols.map(c => this.quote(c)).join(', ')})`,
    ).run()
  }
  async createView(name: string, sql: string): Promise<SQLAdapter.RunResult> {
    await this.drop('VIEW', name)
    return this.query(`CREATE VIEW ${this.quote(name)} AS ${sql}`).run()
  }
  async createTable(
    table: string,
    defs: string[],
    ifNotExists = false,
  ): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}` +
        `${this.quote(table)} (\n${defs.join(',\n')}\n)`,
    ).run()
  }
  async copyTableData(
    from: string,
    to: string,
    cols: string[],
  ): Promise<SQLAdapter.RunResult> {
    const cSql = cols.map(c => this.quote(c)).join(', ')
    return await this.query(
      `INSERT INTO ${this.quote(to)} (${cSql})` +
        ` SELECT ${cSql} FROM ${this.quote(from)}`,
    ).run()
  }

  protected async preSync(_tx: SQLAdapter): Promise<void> {}
  protected async postSync(_tx: SQLAdapter): Promise<void> {}
  /**
   * Patterns recognised when reading a default back *out* of the database.
   * Matched loosely (parens stripped, uppercased, `includes`), so a prefix
   * fragment is a perfectly good entry here.
   */
  readonly dateNowDefaults: string[] = []

  /**
   * The complete SQL expression emitted *into* DDL for a `%dateNow%` default.
   *
   * Deliberately separate from `dateNowDefaults`. Conflating the two — emitting
   * `dateNowDefaults[0]` — is what produced `DEFAULT (EXTRACT(EPOCH FROM)` on
   * Postgres and `DEFAULT (UNIX_TIMESTAMP)` on MySQL: a prefix is fine to match
   * against and fatal to emit. SQLite only escaped because its match pattern
   * happened to be a complete expression.
   */
  readonly dateNowExpression: string = ''

  /**
   * The same pair as `dateNowDefaults` / `dateNowExpression`, for `%uuid%`.
   *
   * Both halves are required, and the read-back half is the one that matters:
   * without it the database reports `gen_random_uuid()` where the schema says
   * `%uuid%`, the two never compare equal, and the column is rebuilt on every
   * sync forever. That failure has happened twice in this codebase already,
   * which is why these are separate fields rather than one clever pattern.
   */
  readonly uuidDefaults: string[] = []
  readonly uuidExpression: string = ''

  isDateNowDefault(def: string): boolean {
    return this.matchesMarker(def, '%dateNow%', this.dateNowDefaults)
  }

  isUuidDefault(def: string): boolean {
    return this.matchesMarker(def, '%uuid%', this.uuidDefaults)
  }

  /**
   * Loose match: parens stripped, uppercased, substring. A prefix fragment is a
   * perfectly good entry in the pattern lists — and is fatal to *emit*, which
   * is the whole reason the emitted expression is a separate field.
   */
  private matchesMarker(
    def: string,
    marker: string,
    patterns: string[],
  ): boolean {
    if (def === marker) return true
    const norm = def.replace(/[()]/g, '').trim().toUpperCase()
    return patterns.some(pattern => {
      const normPattern = pattern.replace(/[()]/g, '').trim().toUpperCase()
      return norm === normPattern || norm.includes(normPattern)
    })
  }

  /**
   * A `CHECK (col IN (…))` clause restricting a column to a set of values.
   *
   * Takes the column name because a CHECK has to name it, which is why
   * `colDef` grew an optional `column` argument. Values bind nowhere — this is
   * DDL — so they are quoted the same way `formatDefault` quotes a string
   * default, by doubling the single quote.
   */
  /**
   * The declared width of a **sized** text column, or `undefined`.
   *
   * The guard is the entire point, and it is not defensive coding — it is a
   * measured result. MySQL reports `character_maximum_length = 65535` for an
   * unsized `TEXT` column, where Postgres reports `null`. Take the number
   * unconditionally and every `Field.Text()` column reads back as
   * `length: 65535`, the schema says nothing, the two never agree, and MySQL
   * rebuilds the table on every sync forever — the exact failure that kept
   * `length` out of the diff until it could be checked against real servers.
   *
   * So: a width counts only when the dialect also calls the column a *sized*
   * text type. `varchar` and `char`, not `text`.
   */
  protected sizedTextLength(
    declaredType: string,
    reported: unknown,
  ): number | undefined {
    const type = declaredType.toLowerCase()
    const sized =
      type.includes('varchar') ||
      type.includes('character varying') ||
      /(^|\W)char(\W|\(|$)/.test(type)
    if (!sized) return undefined
    const n = Number(reported)
    return Number.isInteger(n) && n > 0 ? n : undefined
  }

  protected enumClause(column: string, values: string[]): string {
    const list = values
      .map(v => `'${String(v).replaceAll("'", "''")}'`)
      .join(', ')
    return ` CHECK (${this.quote(column)} IN (${list}))`
  }

  protected parseDefault(def: any): any {
    if (def === null || def === undefined) return def
    const isStr = typeof def === 'string'
    if (isStr && def.toUpperCase() === 'NULL') return null
    // `def.trim() !== ''` first, because `Number('')` is `0` and `Number(' ')`
    // is `0` — so an empty-string default came back as the *number* zero. The
    // schema then said `''`, the database said `0`, and the column was rebuilt
    // on every single sync, forever.
    //
    // Unreachable until now only by accident: MySQL rejects a default on TEXT,
    // which is what `value('string', '')` emitted, so the one shape that
    // triggers it could not be created. `Field.Varchar(n, '')` can.
    if (isStr && def.trim() !== '' && !Number.isNaN(Number(def)))
      return Number(def)
    if (isStr && this.isDateNowDefault(def)) return '%dateNow%'
    if (isStr && this.isUuidDefault(def)) return '%uuid%'
    return def
  }

  async syncSchema(
    constraints: SyncTypes.DBConstraints,
    tsIndexes: SyncTypes.DBIndexes,
    schemaPath: string,
    layout: import('../sync/load').SchemaLayout = 'file',
  ): Promise<void> {
    const { SyncEngine } = await import('../sync/engine')
    await SyncEngine.run(this, constraints, tsIndexes, schemaPath, layout)
  }

  async close() {
    await (this.sql as any)?.close()
  }
  async [Symbol.asyncDispose]() {
    await this.close()
  }
  query(sqlText: string) {
    return new DatabaseStatement(this, sqlText)
  }

  protected buildFilterSort(
    options: SQLAdapter.FilterSortOptions,
    validCols: Set<string>,
  ) {
    const whereParams: unknown[] = []
    const whereClauses = Object.entries(options.filters || {})
      .filter(
        ([col, val]) =>
          validCols.has(col) && val !== undefined && val !== null && val !== '',
      )
      .map(([col, val]) => {
        whereParams.push(`%${val}%`)
        return `${this.quote(col)} LIKE ?`
      })

    const whereSql = whereClauses.length
      ? ` WHERE ${whereClauses.join(' AND ')}`
      : ''
    // Only DESC or ASC ever reaches the string: `sortOrder` arrives off a
    // query parameter, so anything else collapses to ASC rather than being
    // interpolated.
    const direction =
      options.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
    const orderSql =
      options.sortBy && validCols.has(options.sortBy)
        ? ` ORDER BY ${this.quote(options.sortBy)} ${direction}`
        : ''

    return { whereSql, orderSql, whereParams }
  }

  protected formatDefault(
    def: unknown,
    boolTrue: string,
    boolFalse: string,
  ): string {
    if (def === undefined) return ''
    if (def === null || def === 'NULL') return ' DEFAULT NULL'
    if (typeof def === 'boolean')
      return ` DEFAULT ${def ? boolTrue : boolFalse}`
    if (typeof def === 'number' || typeof def === 'bigint')
      return ` DEFAULT ${def}`
    if (typeof def === 'string' && def === '%dateNow%') {
      // Fail loudly rather than emit `DEFAULT ()` or silently drop the
      // default: a missing timestamp default is a schema defect that would
      // otherwise surface much later, as a NOT NULL violation at insert time.
      if (!this.dateNowExpression) {
        throws(`${this.driver} adapter defines no dateNowExpression`)
      }
      return ` DEFAULT (${this.dateNowExpression})`
    }
    if (typeof def === 'string' && def === '%uuid%') {
      // Same reasoning as `%dateNow%` above, and the same failure if silent:
      // a UUID primary key with no default is a NOT NULL violation on the
      // first insert rather than at sync time.
      if (!this.uuidExpression) {
        throws(`${this.driver} adapter defines no uuidExpression`)
      }
      return ` DEFAULT (${this.uuidExpression})`
    }
    return ` DEFAULT '${String(def).replaceAll("'", "''")}'`
  }

  protected async cleanupBackups(
    backupDir: string,
    baseName: string,
    ext: string,
    keepCount: number,
  ): Promise<number> {
    if (keepCount <= 0) return 0
    const files = Array.from(new Bun.Glob('*').scanSync({ cwd: backupDir }))
    const old = files
      .filter(f => f.startsWith(`${baseName}.`) && f.endsWith(ext))
      .map(f => ({ name: f, time: Number(f.split('.')[1]) || 0 }))
      .sort((a, b) => b.time - a.time)
      .slice(keepCount)
    await Promise.all(old.map(b => Bun.file(`${backupDir}/${b.name}`).delete()))
    return old.length
  }

  protected async spawnBackup(
    tool: string,
    cmdBuilder: (fullPath: string) => string[],
    ext: string,
    keepCount: number,
    baseName: string,
    envOverride?: Record<string, string>,
  ): Promise<SQLAdapter.BackupResult | null> {
    const backupDir = `${Bakery.dataDir}/backups`
    const backupName = `${baseName}.${Date.now()}${ext}`
    const fullPath = `${backupDir}/${backupName}`
    await Bun.write(`${backupDir}/.keep`, '')

    if (
      !Try.return(
        () =>
          Bun.spawnSync({ cmd: [tool, '--version'], stdout: 'ignore' })
            .exitCode === 0,
        false,
      )
    ) {
      if (
        !new Logger('db-backup').confirm(
          `${tool} utility not found. Continue without backup?`,
        )
      )
        throw new Error(`Aborted: ${tool} missing.`)
      return null
    }

    const dump = Bun.spawnSync({
      cmd: cmdBuilder(fullPath),
      stdout: 'ignore',
      stderr: 'pipe',
      env: { ...process.env, ...(envOverride || {}) },
    })
    if (!dump.success)
      throw new Error(
        dump.stderr.toString().trim() ||
          `${tool} failed (exit ${dump.exitCode})`,
      )

    const cleaned = await this.cleanupBackups(
      backupDir,
      baseName,
      ext,
      keepCount,
    )
    return { file: backupName, cleanupCount: cleaned }
  }

  async importCSV(
    table: string,
    csvContent: string,
  ): Promise<SQLAdapter.RunResult> {
    const lines = parseCSVRows(csvContent)
    if (lines.length < 2) throw new Error('No rows found')

    const rawHeaders = lines[0]
    const headers = rawHeaders.map(h => h.trim())

    const schema = await this.getSchema()
    const tableInfo = schema.find(
      t => t.name === table || Case.camel(t.name) === Case.camel(table),
    )
    const typeMap = new Map<string, string>() // column name -> type
    if (tableInfo) {
      for (const col of tableInfo.columns) {
        typeMap.set(Case.camel(col.name), col.type.toLowerCase())
        typeMap.set(col.name.toLowerCase(), col.type.toLowerCase())
      }
    }

    const records = lines.slice(1).map(cols => {
      return headers.reduce(
        (acc, h, i) => {
          const type =
            typeMap.get(Case.camel(h)) || typeMap.get(h.toLowerCase())
          acc[h] = parseCSVValue(cols[i], type)
          return acc
        },
        {} as Record<string, any>,
      )
    })

    return await this.insert(table, records)
  }
}

function parseCSVValueWithType(val: string, type: string): any {
  if (type.includes('int') || type.includes('serial')) {
    const parsed = parseInt(val, 10)
    return Number.isNaN(parsed) ? val : parsed
  }
  if (
    type.includes('real') ||
    type.includes('double') ||
    type.includes('float') ||
    type.includes('number') ||
    type.includes('numeric')
  ) {
    const parsed = parseFloat(val)
    return Number.isNaN(parsed) ? val : parsed
  }
  if (type.includes('bool')) {
    return val === 'true' || val === '1' || val === 't'
  }
  return val
}

function parseCSVValueFallback(val: string): any {
  if (!Number.isNaN(Number(val)) && val !== '') {
    return Number(val)
  }
  const lowerVal = val.toLowerCase()
  if (lowerVal === 'true' || lowerVal === 'false') {
    return lowerVal === 'true'
  }
  if (lowerVal === 'null') {
    return null
  }
  return val
}

function parseCSVValue(val: any, type?: string): any {
  if (val === undefined || val === null) {
    return null
  }
  const trimmed = val.trim()
  if (trimmed === '') {
    return null
  }
  if (type) {
    return parseCSVValueWithType(trimmed, type)
  }
  return parseCSVValueFallback(trimmed)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: csv
function parseCSVRows(csv: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i],
      next = csv[i + 1]
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"'
        i++
      } else if (c === '"') inQuotes = false
      else field += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') {
        row.push(field)
        field = ''
      } else if (c === '\n' || c === '\r') {
        row.push(field)
        field = ''
        if (row.length > 0 && !(row.length === 1 && row[0] === ''))
          result.push(row)
        row = []
        if (c === '\r' && next === '\n') i++
      } else field += c
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 0 && !(row.length === 1 && row[0] === '')) result.push(row)
  }
  return result
}

export class DatabaseStatement {
  constructor(
    private readonly connection: SQLAdapter,
    private readonly sql: string,
  ) {}
  all(...params: unknown[]) {
    return this.connection.execute.all(this.sql, params)
  }
  get(...params: any[]) {
    return this.connection.execute.get(this.sql, params)
  }
  run(...params: any[]): Promise<SQLAdapter.RunResult> | SQLAdapter.RunResult {
    return this.connection.execute.run(this.sql, params)
  }
  values(...params: any[]) {
    return this.connection.execute.values(this.sql, params)
  }
  iterate(...params: any[]) {
    return this.connection.execute.iterate(this.sql, params)
  }
}
