import { Case, Try } from '@server/utils'
import { SQL } from 'bun'
import type * as SyncTypes from '../sync/types'
import { createExecutor, SQLAdapter } from './base'

export class MySQLAdapter extends SQLAdapter {
  protected readonly sql: SQL

  constructor(connectionTarget?: string | URL | SQL) {
    const target =
      typeof connectionTarget === 'string' || connectionTarget instanceof URL
        ? connectionTarget.toString().replace(/^(mysqli?s?:\/\/)/, 'mysql://')
        : undefined
    super('mysql', undefined, target)
    this.sql =
      connectionTarget instanceof SQL
        ? connectionTarget
        : target
          ? new SQL(target)
          : new SQL()
  }

  readonly execute: SQLAdapter.Executor = createExecutor(
    async (sqlText: string, params: unknown[] = []) =>
      (await this.sql.unsafe(sqlText, params)) as SQLAdapter.RowRecord[],
    async (
      sqlText: string,
      params: unknown[] = [],
    ): Promise<SQLAdapter.RunResult> => {
      const rows = (await this.sql.unsafe(sqlText, params)) as any
      return {
        lastInsertRowid:
          rows?.insertId ?? rows?.lastInsertRowid ?? rows?.lastInsertId ?? null,
        changes: Number(
          rows?.count ??
            rows?.affectedRows ??
            rows?.changedRows ??
            rows?.length ??
            0,
        ),
      }
    },
    (sqlText: string, params: unknown[] = []) =>
      this.sql.unsafe(sqlText, params) as any,
  )

  async hasCol(table: string, column: string): Promise<boolean> {
    const res = (await this.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()`,
    ).all(table)) as SQLAdapter.ColumnNameRow[]
    return res.some(r => r.column_name === column)
  }

  colDef(def: unknown): string {
    const d = def as any
    const typeStr =
      {
        integer: 'INT',
        string: 'TEXT',
        number: 'DOUBLE',
        boolean: 'TINYINT(1)',
        buffer: 'BLOB',
      }[d.type as string] || 'TEXT'
    let sql = typeStr
    if (d.autoIncrement && d.type === 'integer') sql += ' AUTO_INCREMENT'
    if (d.primary) sql += ' PRIMARY KEY'
    if (!d.nullable && !d.primary) sql += ' NOT NULL'
    return sql + this.formatDefault(d.default, '1', '0')
  }

  override async rename(
    type: 'TABLE' | 'COLUMN',
    ...params: string[]
  ): Promise<SQLAdapter.RunResult> {
    if (type === 'TABLE') {
      const [oldName, newName] = params
      return await this.query(
        `RENAME TABLE ${this.quote(oldName)} TO ${this.quote(newName)}`,
      ).run()
    }
    const [table, oldColumn, newColumn] = params
    try {
      return await this.query(
        `ALTER TABLE ${this.quote(table)} RENAME COLUMN ${this.quote(oldColumn)} TO ${this.quote(newColumn)}`,
      ).run()
    } catch {
      const col = (await this.query(
        'SELECT column_type, is_nullable, column_default, extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      ).get(table, oldColumn)) as any
      const type = String(col?.column_type || 'TEXT')
      const notNull = col?.is_nullable === 'NO' ? ' NOT NULL' : ''
      const defSql = col?.column_default
        ? this.formatDefault(col.column_default, '1', '0')
        : ''
      const extraSql = col?.extra?.trim() ? ` ${col.extra.trim()}` : ''
      return this.query(
        `ALTER TABLE ${this.quote(table)} CHANGE ${this.quote(oldColumn)} ${this.quote(newColumn)} ${type}${notNull}${defSql}${extraSql}`,
      ).run()
    }
  }
  override async createIndex(
    indexName: string,
    tableName: string,
    columns: string[],
    unique = false,
  ): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `ALTER TABLE ${this.quote(tableName)} ADD ${unique ? 'UNIQUE ' : ''}INDEX ${this.quote(indexName)} (${columns.map(c => this.quote(c)).join(', ')})`,
    ).run()
  }

  protected override async preSync(tx: SQLAdapter): Promise<void> {
    await tx.query('SET FOREIGN_KEY_CHECKS = 0').run()
  }
  protected override async postSync(tx: SQLAdapter): Promise<void> {
    await tx.query('SET FOREIGN_KEY_CHECKS = 1').run()
  }

  override async drop(
    type: 'TABLE' | 'VIEW' | 'INDEX' | 'COLUMN',
    ...params: string[]
  ): Promise<SQLAdapter.RunResult> {
    if (type === 'INDEX') {
      const indexName = params[0]
      const row = (await this.query(
        'SELECT DISTINCT table_name FROM information_schema.statistics WHERE index_name = ? AND table_schema = DATABASE()',
      ).get(indexName)) as SQLAdapter.TableNameRow | undefined
      if (row?.table_name)
        return await this.query(
          `DROP INDEX ${this.quote(indexName)} ON ${this.quote(row.table_name)}`,
        ).run()
      try {
        return await this.query(`DROP INDEX ${this.quote(indexName)}`).run()
      } catch {
        return { lastInsertRowid: null, changes: 0 }
      }
    }
    return await super.drop(type, ...params)
  }

  async backup(keepCount = 10): Promise<SQLAdapter.BackupResult | null> {
    if (!this.url) return null
    const parsed = new URL(this.url)
    const base = Try.return(
      () => parsed.pathname.replace(/^\//, '') || 'mysql',
      'mysql',
    )

    return await this.spawnBackup(
      'mysqldump',
      fullPath => {
        const cmd = [
          'mysqldump',
          `--host=${parsed.hostname || 'localhost'}`,
          `--port=${parsed.port || '3306'}`,
          `--user=${parsed.username || 'root'}`,
          `--result-file=${fullPath}`,
          base,
        ]
        return cmd
      },
      '.sql',
      keepCount,
      base,
      parsed.password
        ? { MYSQL_PWD: decodeURIComponent(parsed.password) }
        : undefined,
    )
  }

  async transaction<T>(
    callback: (tx: SQLAdapter) => T | Promise<T>,
  ): Promise<T> {
    return await this.sql.transaction(async txSql =>
      callback(new MySQLAdapter(txSql)),
    )
  }

  async getSchema(): Promise<SQLAdapter.TableDetails[]> {
    const res = (await this.query(
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
    ).all()) as SQLAdapter.NameRow[]
    const tablesWithDetails: SQLAdapter.TableDetails[] = []
    for (const t of res) {
      const [countRes, cols, idxs] = (await Promise.all([
        this.query(`SELECT COUNT(*) as count FROM ${this.quote(t.name)}`).get(),
        this.query(
          `SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_key AS column_key FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE() ORDER BY ordinal_position`,
        ).all(t.name),
        this.query(
          `SELECT index_name AS name, non_unique AS non_unique FROM information_schema.statistics WHERE table_name = ? AND table_schema = DATABASE()`,
        ).all(t.name),
      ])) as [SQLAdapter.CountRow, any[], any[]]
      const uniqueIdxs = Array.from(
        new Map(idxs.map(i => [i.name, i.non_unique === 0])).entries(),
      ).map(([name, unique]) => ({ name, unique }))
      tablesWithDetails.push({
        name: t.name,
        rowCount: countRes?.count || 0,
        columns: cols.map(c => ({
          name: c.name,
          type: c.type,
          notnull: c.is_nullable === 'NO',
          pk: c.column_key === 'PRI',
        })),
        indexes: uniqueIdxs,
      })
    }
    return tablesWithDetails
  }

  async getData(
    tableName: string,
    options: SQLAdapter.TableDataOptions,
  ): Promise<SQLAdapter.TableDataResult> {
    const cols = (await this.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()`,
    ).all(tableName)) as SQLAdapter.NameRow[]
    const { whereSql, orderSql, whereParams } = this.buildFilterSort(
      options,
      new Set(cols.map(c => c.name)),
    )
    const tName = this.quote(tableName)
    const countRes = (await this.query(
      `SELECT COUNT(*) as count FROM ${tName}${whereSql}`,
    ).get(...whereParams)) as SQLAdapter.CountRow
    const totalRows = countRes?.count || 0
    const rows = await this.query(
      `SELECT * FROM ${tName}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
    ).all(
      ...whereParams,
      options.pageSize,
      (options.page - 1) * options.pageSize,
    )
    return {
      rows,
      totalRows,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: Math.ceil(totalRows / options.pageSize),
    }
  }

  async remove(
    tableName: string,
    rowid: unknown,
  ): Promise<SQLAdapter.RunResult> {
    const tableInfo = (await this.getSchema()).find(t => t.name === tableName)
    const pk = tableInfo?.columns.find(c => c.pk)?.name || 'id'
    return await this.query(
      `DELETE FROM ${this.quote(tableName)} WHERE ${this.quote(pk)} = ?`,
    ).run(rowid)
  }

  async truncate(tableName: string): Promise<SQLAdapter.RunResult> {
    return await this.query(`TRUNCATE TABLE ${this.quote(tableName)}`).run()
  }
  async update(
    tableName: string,
    rowid: unknown,
    row: SQLAdapter.RowRecord,
  ): Promise<SQLAdapter.RunResult> {
    const keys = Object.keys(row).filter(k => k !== 'rowid')
    const tableInfo = (await this.getSchema()).find(t => t.name === tableName)
    const pk = tableInfo?.columns.find(c => c.pk)?.name || 'id'
    return await this.query(
      `UPDATE ${this.quote(tableName)} SET ${keys.map(k => `${this.quote(k)} = ?`).join(', ')} WHERE ${this.quote(pk)} = ?`,
    ).run(...keys.map(k => row[k]), rowid)
  }

  async getConstraints(): Promise<SyncTypes.DBConstraints> {
    const tables = (await this.query(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE','VIEW')",
    ).all()) as any[]
    const dbConstraints: SyncTypes.DBConstraints = {}

    for (const t of tables) {
      const tName = Case.camel(t.table_name)
      dbConstraints[tName] = {} as SyncTypes.TableConstraints

      if (t.table_type === 'VIEW') {
        const viewDef = (await this.query(
          'SELECT view_definition FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = ?',
        ).get(t.table_name)) as any
        if (viewDef?.view_definition)
          dbConstraints[tName]._view = viewDef.view_definition
      }

      const cols = (await this.query(
        'SELECT column_name, column_type, data_type, is_nullable, column_key, column_default, extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
      ).all(t.table_name)) as any[]

      for (const col of cols) {
        dbConstraints[tName][Case.camel(col.column_name)] =
          this.parseConstraints(col)
      }
    }
    return dbConstraints
  }

  async getIndexes(): Promise<SyncTypes.DBIndexes> {
    const rows = (await this.query(
      'SELECT index_name, non_unique, table_name, column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name IS NOT NULL ORDER BY index_name, seq_in_index',
    ).all()) as any[]
    const idxMap: Record<
      string,
      { table: string; cols: string[]; non_unique: number }
    > = {}
    for (const r of rows) {
      if (!r.index_name || r.index_name.toUpperCase() === 'PRIMARY') continue
      idxMap[r.index_name] ??= {
        table: r.table_name,
        cols: [],
        non_unique: r.non_unique,
      }
      idxMap[r.index_name].cols.push(r.column_name)
    }
    return Object.fromEntries(
      Object.entries(idxMap).map(([name, info]) => [
        Case.camel(name),
        {
          type: info.non_unique === 0 ? 'unique' : 'index',
          table: Case.camel(info.table),
          cols: info.cols.map(Case.camel),
        },
      ]),
    )
  }
  override readonly dateNowDefaults: string[] = ['UNIX_TIMESTAMP']

  protected override parseConstraints(col: any): SyncTypes.ColumnConstraint {
    const primary = col.column_key === 'PRI'
    const cons: SyncTypes.ColumnConstraint = {
      type: MySQLAdapter.mapMySqlTypeToTsType(
        String(col.data_type || col.column_type || ''),
      ),
    }
    if (primary) cons.primary = true
    if (
      String(col.extra || '')
        .toLowerCase()
        .includes('auto_increment')
    )
      cons.autoIncrement = true
    if (col.is_nullable === 'YES' && !primary) cons.nullable = true

    let def = this.parseDefault(col.column_default)
    if (typeof def === 'string' && def === '%dateNow%') def = `'${def}'`
    if (def !== undefined) cons.default = def
    return cons
  }

  private static readonly mysqlTypes = [
    {
      test: (t: string) =>
        t.includes('tinyint(1)') ||
        t === 'bit(1)' ||
        t === 'boolean' ||
        t === 'bool',
      type: 'boolean' as const,
    },
    {
      test: (t: string) =>
        t.includes('int') ||
        t.includes('serial') ||
        t.includes('bigint') ||
        t.includes('smallint') ||
        t.includes('mediumint'),
      type: 'integer' as const,
    },
    {
      test: (t: string) =>
        t.includes('char') ||
        t.includes('text') ||
        t.includes('enum') ||
        t.includes('set') ||
        t.includes('date') ||
        t.includes('time') ||
        t.includes('timestamp'),
      type: 'string' as const,
    },
    {
      test: (t: string) =>
        t.includes('blob') || t.includes('binary') || t.includes('varbinary'),
      type: 'buffer' as const,
    },
    {
      test: (t: string) =>
        t.includes('double') ||
        t.includes('float') ||
        t.includes('decimal') ||
        t.includes('numeric'),
      type: 'number' as const,
    },
  ]

  private static mapMySqlTypeToTsType(
    sqlType: string,
  ): SyncTypes.ColumnConstraint['type'] {
    const t = (sqlType || '').toLowerCase()
    for (const m of MySQLAdapter.mysqlTypes) {
      if (m.test(t)) return m.type
    }
    return 'string'
  }
}
