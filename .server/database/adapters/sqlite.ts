import path from 'node:path'
import { Case, Try } from '@server/utils'
import { SQL } from 'bun'
import type * as SyncTypes from '../sync/types'
import { createExecutor, SQLAdapter } from './base'

export class SQLiteAdapter extends SQLAdapter {
  protected readonly sql: SQL
  private static readonly sqliteTypes: [
    string,
    SyncTypes.ColumnConstraint['type'],
  ][] = [
    ['INTEGER', 'integer'],
    ['TEXT', 'string'],
    ['REAL', 'number'],
    ['BLOB', 'buffer'],
    ['NUMERIC', 'number'],
    ['BOOLEAN', 'boolean'],
  ]
  private static readonly sqlKeywords = new Set([
    'SELECT',
    'FROM',
    'WHERE',
    'JOIN',
    'LEFT',
    'RIGHT',
    'INNER',
    'OUTER',
    'ON',
    'AS',
    'AND',
    'OR',
    'NOT',
    'NULL',
    'IS',
    'IN',
    'GROUP',
    'BY',
    'ORDER',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'ASC',
    'DESC',
    'CREATE',
    'TABLE',
    'VIEW',
    'DROP',
    'ALTER',
    'UPDATE',
    'SET',
    'INSERT',
    'INTO',
    'VALUES',
    'DELETE',
    'PRIMARY',
    'KEY',
    'FOREIGN',
    'REFERENCES',
    'AUTOINCREMENT',
    'DEFAULT',
    'UNIQUE',
    'CHECK',
    'CONSTRAINT',
    'CAST',
    'INTEGER',
    'TEXT',
    'REAL',
    'BLOB',
    'NUMERIC',
    'BOOLEAN',
  ])
  private static cleanSQLQuotes(sql: string): string {
    return sql.replace(/`([^`]+)`/g, (match, word) =>
      !SQLiteAdapter.sqlKeywords.has(word.toUpperCase()) &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(word)
        ? word
        : match,
    )
  }
  private static mapSqlToTsType(
    sqlType: string,
  ): SyncTypes.ColumnConstraint['type'] {
    const upperType = (sqlType || '').toUpperCase()
    for (const [sql, ts] of SQLiteAdapter.sqliteTypes) {
      if (upperType.includes(sql)) return ts
    }
    return 'string'
  }

  constructor(connectionTarget?: string | null, sql?: SQL) {
    const filename = SQLiteAdapter.resolveFilename(connectionTarget)
    super(
      'sqlite',
      filename,
      typeof connectionTarget === 'string' ? connectionTarget : undefined,
    )
    if (filename !== ':memory:') {
      const dir = path.dirname(filename)
      Try(() => {
        const { mkdirSync } = require('node:fs')
        mkdirSync(dir, { recursive: true })
      })
    }
    this.sql =
      sql ??
      (filename === ':memory:'
        ? new SQL('sqlite://:memory:')
        : new SQL(filename, { adapter: 'sqlite' }))
    if (filename !== ':memory:') {
      const cacheSize = import.meta.env.THREAD_WORKER ? -1000 : -10000
      const journalMode = process.platform === 'win32' ? 'DELETE' : 'WAL'
      this.sql
        .unsafe(`PRAGMA journal_mode = ${journalMode};`)
        .then(() => this.sql.unsafe('PRAGMA synchronous = NORMAL;'))
        .then(() => this.sql.unsafe('PRAGMA temp_store = memory;'))
        .then(() => this.sql.unsafe(`PRAGMA cache_size = ${cacheSize};`))
        .then(() => this.sql.unsafe('PRAGMA busy_timeout = 5000;'))
        .then(() => this.sql.unsafe('PRAGMA mmap_size = 0;'))
        .catch(() => {})
    }
  }

  private static resolveFilename(rawValue?: string | null): string {
    const envVal = process.env.DATABASE_URL || process.env.SQLITE_PATH
    const fallback = path.resolve(process.cwd(), '.server/.data/server.db')
    const value =
      rawValue?.trim() ||
      (typeof envVal === 'string' ? envVal.trim() : undefined)

    if (!value) return fallback
    if (value === ':memory:' || path.isAbsolute(value)) return value

    if (value.startsWith('sqlite://'))
      return this.resolveFilename(value.slice('sqlite://'.length))
    if (value.startsWith('sqlite:'))
      return this.resolveFilename(
        value.slice('sqlite:'.length).replace(/^\/+/, ''),
      )
    if (value.startsWith('file://'))
      return Try.return(() => Bun.fileURLToPath(new URL(value)), fallback)
    return path.resolve(process.cwd(), value)
  }

  readonly execute: SQLAdapter.Executor = createExecutor(
    async (sqlText: string, params: unknown[] = []) =>
      (await this.sql.unsafe(sqlText, params)) as SQLAdapter.RowRecord[],
    async (
      sqlText: string,
      params: unknown[] = [],
    ): Promise<SQLAdapter.RunResult> => {
      const result = (await this.sql.unsafe(sqlText, params)) as any
      return {
        lastInsertRowid:
          result?.lastInsertRowid ??
          result?.insertId ??
          result?.lastInsertId ??
          null,
        changes: Number(
          result?.count ?? result?.affectedRows ?? result?.changedRows ?? 0,
        ),
      }
    },
    (sqlText: string, params: unknown[] = []) =>
      this.sql.unsafe(sqlText, params) as any,
  )

  async hasCol(table: string, column: string): Promise<boolean> {
    const cols = (await this.query(
      `PRAGMA table_info('${table}')`,
    ).all()) as SQLAdapter.NameRow[]
    return cols.some(c => c.name === column)
  }

  colDef(def: unknown): string {
    const d = def as any
    const typeStr =
      {
        integer: 'INTEGER',
        string: 'TEXT',
        number: 'REAL',
        boolean: 'INTEGER',
        buffer: 'BLOB',
      }[d.type as string] || 'TEXT'
    let out = typeStr
    if (d.primary) out += ' PRIMARY KEY'
    if (d.autoIncrement) out += ' AUTOINCREMENT'
    if (!d.nullable && !d.primary) out += ' NOT NULL'
    return out + this.formatDefault(d.default, '1', '0')
  }

  async backup(keepCount = 10): Promise<SQLAdapter.BackupResult | null> {
    if (
      this.filename === ':memory:' ||
      !this.filename ||
      !(await Bun.file(this.filename).exists())
    )
      return null
    const ext = path.extname(this.filename),
      base = path.basename(this.filename, ext)
    const backupDir = `${path.dirname(this.filename)}/backups`,
      backupName = `${base}.${Date.now()}${ext}`
    await Bun.write(`${backupDir}/${backupName}`, Bun.file(this.filename))
    return {
      file: backupName,
      cleanupCount: await this.cleanupBackups(backupDir, base, ext, keepCount),
    }
  }

  transaction<T>(callback: (tx: SQLAdapter) => T | Promise<T>): Promise<T> {
    return this.sql.transaction(async txSql =>
      callback(new SQLiteAdapter(this.filename, txSql)),
    )
  }

  async getSchema(): Promise<SQLAdapter.TableDetails[]> {
    const res = (await this.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all()) as SQLAdapter.NameRow[]
    const tablesWithDetails: SQLAdapter.TableDetails[] = []
    for (const t of res) {
      const tableName = this.quote(t.name)

      const [countRes, cols, idxs] = (await Promise.all([
        this.query(`SELECT COUNT(*) as count FROM ${tableName}`).get(),
        this.query(`PRAGMA table_info(${tableName})`).all(),
        this.query(`PRAGMA index_list(${tableName})`).all(),
      ])) as [SQLAdapter.CountRow, any[], any[]]

      tablesWithDetails.push({
        name: t.name,
        rowCount: countRes?.count || 0,
        columns: cols.map(c => ({
          name: c.name,
          type: c.type,
          notnull: c.notnull === 1,
          pk: c.pk === 1,
        })),
        indexes: idxs.map(i => ({ name: i.name, unique: i.unique === 1 })),
      })
    }
    return tablesWithDetails
  }

  async getData(
    tableName: string,
    options: SQLAdapter.TableDataOptions,
  ): Promise<SQLAdapter.TableDataResult> {
    const tname = this.quote(tableName)
    const cols = (await this.query(
      `PRAGMA table_info(${tname})`,
    ).all()) as SQLAdapter.NameRow[]
    const { whereSql, orderSql, whereParams } = this.buildFilterSort(
      options,
      new Set(cols.map(c => c.name)),
    )

    const { page, pageSize } = options

    const [countRes, rows] = (await Promise.all([
      this.query(`SELECT COUNT(*) as count FROM ${tname}${whereSql}`).get(
        ...whereParams,
      ),
      this.query(
        `SELECT rowid AS rowid, * FROM ${tname}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
      ).all(...whereParams, pageSize, (page - 1) * pageSize),
    ])) as [SQLAdapter.CountRow, any[]]

    const totalRows = countRes?.count || 0
    return {
      rows,
      totalRows,
      page: page,
      pageSize: pageSize,
      totalPages: Math.ceil(totalRows / pageSize),
    }
  }

  async remove(table: string, rowid: unknown): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `DELETE FROM ${this.quote(table)} WHERE rowid = ?`,
    ).run(rowid)
  }

  async truncate(table: string): Promise<SQLAdapter.RunResult> {
    await this.query(`DELETE FROM ${this.quote(table)}`).run()
    return this.query(`VACUUM`).run()
  }

  async update(table: string, rowid: unknown, row: SQLAdapter.RowRecord) {
    const keys = Object.keys(row).filter(k => k !== 'rowid')
    return await this.query(
      `UPDATE ${this.quote(table)} 
      SET ${keys.map(k => `${this.quote(k)} = ?`).join(', ')} 
      WHERE rowid = ?`,
    ).run(...keys.map(k => row[k]), rowid)
  }

  async getConstraints(): Promise<SyncTypes.DBConstraints> {
    const tables = (await this.query(
      "SELECT sql,name,type FROM sqlite_master WHERE (type='table' OR type='view') AND name NOT LIKE 'sqlite_%'",
    ).all()) as any[]

    const dbConstraints: SyncTypes.DBConstraints = {}

    for (const table of tables) {
      const tName = Case.camel(table.name)
      dbConstraints[tName] = {} as SyncTypes.TableConstraints

      const cols = (await this.query(
        `PRAGMA table_info('${table.name}')`,
      ).all()) as any[]

      if (table.type === 'view') {
        const match = table.sql.match(/AS\s+(.*)/is)
        if (match)
          dbConstraints[tName]._view = SQLiteAdapter.cleanSQLQuotes(
            match[1].trim(),
          )

        for (const col of cols) {
          dbConstraints[tName][Case.camel(col.name)] = {
            type: SQLiteAdapter.mapSqlToTsType(col.type),
            nullable: col.notnull === 0n || col.notnull === 0,
          }
        }
        continue
      }

      for (const col of cols) {
        dbConstraints[tName][Case.camel(col.name)] = this.parseConstraints(
          col,
          table.sql,
        )
      }
    }

    return dbConstraints
  }

  async getIndexes(): Promise<SyncTypes.DBIndexes> {
    const indexes = (await this.query(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_autoindex_%'",
    ).all()) as any[]
    return Object.fromEntries(
      await Promise.all(
        indexes.map(async idx => [
          Case.camel(idx.name),
          {
            type: idx.sql.toUpperCase().includes('UNIQUE') ? 'unique' : 'index',
            table: Case.camel(idx.tbl_name),
            cols: (
              (await this.query(
                `PRAGMA index_info('${idx.name}')`,
              ).all()) as any[]
            ).map(c => Case.camel(c.name)),
          },
        ]),
      ),
    )
  }

  protected override async preSync(tx: SQLAdapter): Promise<void> {
    await tx.query('PRAGMA foreign_keys=OFF').run()
  }
  protected override async postSync(tx: SQLAdapter): Promise<void> {
    await tx.query('PRAGMA foreign_keys=ON').run()
  }
  override readonly dateNowDefaults: string[] = [
    "CAST(strftime('%s', 'now') AS INTEGER)",
  ]

  protected override parseConstraints(
    col: any,
    tableSql = '',
  ): SyncTypes.ColumnConstraint {
    const primary = col.pk > 0
    const cons: SyncTypes.ColumnConstraint = {
      type: SQLiteAdapter.mapSqlToTsType(col.type),
    }

    if (primary) cons.primary = true
    if (
      primary &&
      cons.type === 'integer' &&
      tableSql?.toUpperCase().includes('AUTOINCREMENT')
    ) {
      cons.autoIncrement = true
    }

    if (col.notnull === 0 && !primary) cons.nullable = true

    const parsedDef = this.parseDefault(col.dflt_value)
    if (parsedDef !== undefined) cons.default = parsedDef

    return cons
  }

  private parseDefault(def: any): any {
    if (def === null || def === undefined) return def
    const isStr = typeof def === 'string'
    if (isStr && (def.startsWith("'") || def.startsWith('"'))) {
      const unquoted = def.slice(1, -1)
      if (unquoted === '%dateNow%') return def
      return unquoted
    }
    return super.parseDefault(def)
  }
}
