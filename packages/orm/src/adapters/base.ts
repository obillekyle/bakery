import { Bakery } from '@bakery/core/core/bakery'
import { Logger } from '@bakery/core/logger'
import type { MapOf } from '@bakery/core/types'
import { Case, Try } from '@bakery/core/utils'
import { throws } from '@bakery/core/utils/common'
import type * as SyncTypes from '../sync/types'

export namespace SQLAdapter {
  export type Driver = 'sqlite' | 'postgres' | 'mysql'
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
  export interface ColumnConstraint {
    type: 'integer' | 'string' | 'number' | 'boolean' | 'buffer'
    primary?: boolean
    autoIncrement?: boolean
    nullable?: boolean
    default?: unknown
  }
  export interface IndexConstraint {
    type: 'unique' | 'index'
    table: string
    cols: string[]
  }

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
  export interface SQLiteColumnRow {
    name: string
    type?: string
    notnull?: number
    pk?: number
  }
  export interface StatementResult {
    sql: string
    params: unknown[]
  }
  export interface WhereEvalResult {
    whereSql: string
    params: unknown[]
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

export function quoteIdentifier(name: string, quoteChar: string): string {
  // The `includes` guard is not redundant: `replaceAll` walks and rebuilds the
  // string even when there is nothing to replace, and an identifier containing
  // its own dialect's quote character is the rare case, not the common one.
  // This runs for every identifier of every emitted statement.
  return name.includes(quoteChar)
    ? `${quoteChar}${name.replaceAll(quoteChar, '')}${quoteChar}`
    : `${quoteChar}${name}${quoteChar}`
}
export function createExecutor(
  all: SQLAdapter.Executor['all'],
  run: SQLAdapter.Executor['run'],
  iterate: SQLAdapter.Executor['iterate'],
): SQLAdapter.Executor {
  const exec: SQLAdapter.Executor = {
    all,
    run,
    iterate,
    get: async (sqlText: string, params: unknown[] = []) =>
      (await exec.all(sqlText, params))[0],
    values: async (sqlText: string, params: unknown[] = []) =>
      (await exec.all(sqlText, params)).map(Object.values),
  }
  return exec
}

export abstract class SQLAdapter {
  protected abstract sql: unknown
  static readonly DATE_NOW = ''
  readonly DATE_NOW = SQLAdapter.DATE_NOW
  readonly quoteChar: string = '`'

  quote(name: string): string {
    return quoteIdentifier(name, this.quoteChar)
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
      `ALTER TABLE ${this.quote(table)} ADD COLUMN ${this.quote(column)} ${this.colDef(def)}`,
    ).run()
  }
  abstract colDef(def: unknown): string
  abstract backup(keepCount?: number): Promise<SQLAdapter.BackupResult | null>
  abstract transaction<T>(
    callback: (tx: SQLAdapter) => T | Promise<T>,
  ): Promise<T>
  protected abstract parseConstraints(
    col: unknown,
    ...params: unknown[]
  ): SyncTypes.ColumnConstraint
  abstract getConstraints(): Promise<SyncTypes.DBConstraints>
  abstract getIndexes(): Promise<SyncTypes.DBIndexes>
  abstract getSchema(): Promise<SQLAdapter.TableDetails[]>
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
    const placeholderGroup = `(${Array(columnsList.length).fill('?').join(', ')})`
    const placeholders = Array(formattedRecords.length)
      .fill(placeholderGroup)
      .join(', ')
    const params = formattedRecords.flatMap(r =>
      columnsList.map(k => r[k] ?? null),
    )
    return await this.execute.run(
      `INSERT INTO ${this.quote(Case.snake(table))} (${columns}) VALUES ${placeholders}`,
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
        `ALTER TABLE ${this.quote(params[0])} DROP COLUMN ${this.quote(params[1])}`,
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
        `ALTER TABLE ${this.quote(params[0])} RENAME TO ${this.quote(params[1])}`,
      ).run()
    }
    return await this.query(
      `ALTER TABLE ${this.quote(params[0])} RENAME COLUMN ${this.quote(params[1])} TO ${this.quote(params[2])}`,
    ).run()
  }
  async createIndex(
    name: string,
    table: string,
    cols: string[],
    unique = false,
  ): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${this.quote(name)} ON ${this.quote(table)} (${cols.map(c => this.quote(c)).join(', ')})`,
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
      `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${this.quote(table)} (\n${defs.join(',\n')}\n)`,
    ).run()
  }
  async copyTableData(
    from: string,
    to: string,
    cols: string[],
  ): Promise<SQLAdapter.RunResult> {
    const cSql = cols.map(c => this.quote(c)).join(', ')
    return await this.query(
      `INSERT INTO ${this.quote(to)} (${cSql}) SELECT ${cSql} FROM ${this.quote(from)}`,
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

  isDateNowDefault(def: string): boolean {
    if (def === '%dateNow%') return true
    const norm = def.replace(/[()]/g, '').trim().toUpperCase()
    return this.dateNowDefaults.some(dVal => {
      const normD = dVal.replace(/[()]/g, '').trim().toUpperCase()
      return norm === normD || norm.includes(normD)
    })
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
    const orderSql =
      options.sortBy && validCols.has(options.sortBy)
        ? ` ORDER BY ${this.quote(options.sortBy)} ${options.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`
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
