import { Case, Try } from '@bakery/core/utils'
import { SQL } from 'bun'
import type * as SyncTypes from '../sync/types'
import { createExecutor, SQLAdapter } from './base'

interface PGSQLParserState {
  inSingleQuote: boolean
  inDoubleQuote: boolean
  paramIndex: number
  skipNext: boolean
  paramsLength: number
}

export class PGAdapter extends SQLAdapter {
  protected readonly sql: SQL
  override readonly quoteChar: string = '"'

  constructor(connectionTarget?: string | URL | SQL) {
    const target =
      typeof connectionTarget === 'string' || connectionTarget instanceof URL
        ? connectionTarget.toString()
        : undefined
    super('postgres', undefined, target)
    this.sql =
      connectionTarget instanceof SQL
        ? connectionTarget
        : target
          ? new SQL(target)
          : new SQL()
  }

  private static handleQuote(
    char: string,
    nextChar: string | undefined,
    state: PGSQLParserState,
  ): string | null {
    if (char === "'") {
      if (state.inSingleQuote && nextChar === "'") {
        state.skipNext = true
        return "''"
      }
      state.inSingleQuote = !state.inSingleQuote && !state.inDoubleQuote
      return char
    }
    if (char === '"') {
      state.inDoubleQuote = !state.inDoubleQuote && !state.inSingleQuote
      return char
    }
    return null
  }

  private static handleSpecial(
    char: string,
    nextChar: string | undefined,
    state: PGSQLParserState,
  ): string | null {
    if (char === '\\') {
      if ((state.inSingleQuote || state.inDoubleQuote) && nextChar) {
        state.skipNext = true
        return `\\${nextChar}`
      }
      return char
    }
    if (char === '`') {
      return !state.inSingleQuote && !state.inDoubleQuote ? '"' : char
    }
    if (char === '?') {
      return !state.inSingleQuote &&
        !state.inDoubleQuote &&
        state.paramsLength > 0
        ? `$${++state.paramIndex}`
        : char
    }
    return null
  }

  private static normalizePostgresSQL(sql: string, params: unknown[]) {
    let result = ''
    const state: PGSQLParserState = {
      inSingleQuote: false,
      inDoubleQuote: false,
      paramIndex: 0,
      skipNext: false,
      paramsLength: params.length,
    }
    // `skipNext` is consumed in exactly one place — the `i++` below — and
    // cleared there.
    //
    // It used to be consumed twice: a top-of-loop `if (state.skipNext) continue`
    // *and* the `i++`. A handler that set the flag therefore ate two characters
    // instead of one, so every doubled quote swallowed whatever followed it:
    // `'a''b'` was rewritten to `'a'''`, which Postgres reads as `a'`. A string
    // default containing an apostrophe silently lost the rest of its value, and
    // the same applied to a backslash escape. Values bind as parameters, so this
    // only ever reached literals the framework itself emits — DDL defaults —
    // which is why it survived: `ddl.test.ts` asserts the SQL *before*
    // normalisation, and no live server ran until now.
    for (let i = 0; i < sql.length; i++) {
      const char = sql[i]
      const nextChar = sql[i + 1]

      const handled =
        PGAdapter.handleQuote(char, nextChar, state) ??
        PGAdapter.handleSpecial(char, nextChar, state)

      if (handled !== null) {
        result += handled
        if (state.skipNext) {
          state.skipNext = false
          i++
        }
        continue
      }
      result += char
    }
    return result
  }

  readonly execute: SQLAdapter.Executor = createExecutor(
    async (sqlText: string, params: unknown[] = []) =>
      (await this.sql.unsafe(
        PGAdapter.normalizePostgresSQL(sqlText, params),
        params,
      )) as any,
    async (
      sqlText: string,
      params: unknown[] = [],
    ): Promise<SQLAdapter.RunResult> => {
      let sql = sqlText
      const isInsert = /^\s*insert\s+into\s+/i.test(sql)
      if (isInsert && !/\breturning\b/i.test(sql)) sql += ' RETURNING *'

      const rows = (await this.sql.unsafe(
        PGAdapter.normalizePostgresSQL(sql, params),
        params,
      )) as any
      const changes = Number(
        !Array.isArray(rows)
          ? (rows?.count ?? rows?.affectedRows ?? 0)
          : rows.length,
      )
      let lastInsertRowid = null

      if (isInsert && Array.isArray(rows) && rows.length > 0) {
        const firstRow = rows[0]
        if (firstRow)
          lastInsertRowid =
            firstRow.id ??
            firstRow.id_user ??
            Object.values(firstRow)[0] ??
            null
      }
      return { lastInsertRowid, changes }
    },
    (sqlText: string, params: unknown[] = []) =>
      this.sql.unsafe(
        PGAdapter.normalizePostgresSQL(sqlText, params),
        params,
      ) as any,
  )

  async hasCol(table: string, column: string): Promise<boolean> {
    const res = await this.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ? AND table_schema = current_schema()`,
    ).all(table, column)
    return res.length > 0
  }

  colDef(def: unknown): string {
    const d = def as any
    let typeStr =
      {
        integer: 'INTEGER',
        string: 'TEXT',
        number: 'DOUBLE PRECISION',
        boolean: 'BOOLEAN',
        buffer: 'BYTEA',
      }[d.type as string] || 'TEXT'
    if (d.autoIncrement && d.type === 'integer')
      typeStr = 'INTEGER GENERATED BY DEFAULT AS IDENTITY'

    let sql = `${typeStr}`
    if (d.primary) sql += ' PRIMARY KEY'
    if (!d.nullable && !d.primary) sql += ' NOT NULL'
    return sql + this.formatDefault(d.default, 'TRUE', 'FALSE')
  }

  async backup(keepCount = 10): Promise<SQLAdapter.BackupResult | null> {
    if (!this.url) return null
    const base = Try.return(
      () => new URL(this.url!).pathname.replace(/^\//, ''),
      'postgres',
    )

    const parsed = new URL(this.url!)
    const safeUrl = new URL(this.url!)
    safeUrl.password = ''
    const envOverride = parsed.password
      ? { PGPASSWORD: decodeURIComponent(parsed.password) }
      : undefined

    return await this.spawnBackup(
      'pg_dump',
      fullPath => [
        'pg_dump',
        '--dbname',
        safeUrl.toString(),
        '--no-owner',
        '--no-privileges',
        '--file',
        fullPath,
      ],
      '.sql',
      keepCount,
      base,
      envOverride,
    )
  }

  async transaction<T>(
    callback: (tx: SQLAdapter) => T | Promise<T>,
  ): Promise<T> {
    return await this.sql.transaction(async txSql =>
      callback(new PGAdapter(txSql)),
    )
  }

  async getSchema(): Promise<SQLAdapter.TableDetails[]> {
    const res = (await this.query(
      "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name",
    ).all()) as any[]
    const tablesWithDetails: SQLAdapter.TableDetails[] = []

    for (const t of res) {
      const qName = this.quote(t.name)
      const [countRes, cols, pkCols, idxs] = (await Promise.all([
        this.query(`SELECT COUNT(*)::int as count FROM ${qName}`).get(),
        this.query(
          `SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY ordinal_position`,
        ).all(t.name),
        this.query(
          `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND i.indrelid = ${qName}::regclass`,
        ).all(),
        this.query(
          `SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename = ?`,
        ).all(t.name),
      ])) as [SQLAdapter.CountRow, any[], any[], any[]]
      tablesWithDetails.push({
        name: t.name,
        rowCount: countRes?.count || 0,
        columns: cols.map(c => ({
          name: c.name,
          type: c.type,
          notnull: c.is_nullable === 'NO',
          pk: pkCols.some(pk => pk.name === c.name),
        })),
        indexes: idxs.map(i => ({
          name: i.name,
          unique: /UNIQUE/i.test(i.def),
        })),
      })
    }
    return tablesWithDetails
  }

  async getData(
    tableName: string,
    options: SQLAdapter.TableDataOptions,
  ): Promise<SQLAdapter.TableDataResult> {
    const cols = (await this.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
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
    const rows = (await this.query(
      `SELECT ctid::text AS rowid, * FROM ${tName}${whereSql}${orderSql} LIMIT ? OFFSET ?`,
    ).all(
      ...whereParams,
      options.pageSize,
      (options.page - 1) * options.pageSize,
    )) as any[]
    return {
      rows,
      totalRows,
      page: options.page,
      pageSize: options.pageSize,
      totalPages: Math.ceil(totalRows / options.pageSize),
    }
  }

  async remove(tableName: string, rowid: unknown): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `DELETE FROM ${this.quote(tableName)} WHERE ctid::text = ?`,
    ).run(rowid)
  }
  async truncate(tableName: string): Promise<SQLAdapter.RunResult> {
    return await this.query(
      `TRUNCATE TABLE ${this.quote(tableName)} RESTART IDENTITY CASCADE`,
    ).run()
  }
  async update(
    tableName: string,
    rowid: unknown,
    row: SQLAdapter.RowRecord,
  ): Promise<SQLAdapter.RunResult> {
    const keys = Object.keys(row).filter(k => k !== 'rowid')
    return await this.query(
      `UPDATE ${this.quote(tableName)} SET ${keys.map(k => `${this.quote(k)} = ?`).join(', ')} WHERE ctid::text = ?`,
    ).run(...keys.map(k => row[k]), rowid)
  }

  async getConstraints(): Promise<SyncTypes.DBConstraints> {
    const tables = (await this.query(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = current_schema() AND table_type IN ('BASE TABLE','VIEW')",
    ).all()) as any[]
    const pkRows = (await this.query(
      "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.constraint_schema = current_schema()",
    ).all()) as any[]
    const pkMap = pkRows.reduce(
      (acc, r) => {
        if (!acc[r.table_name]) {
          acc[r.table_name] = new Set()
        }
        acc[r.table_name].add(r.column_name)
        return acc
      },
      {} as Record<string, Set<string>>,
    )
    const dbConstraints: SyncTypes.DBConstraints = {}

    for (const t of tables) {
      const tName = Case.camel(t.table_name)
      dbConstraints[tName] = {} as SyncTypes.TableConstraints

      if (t.table_type === 'VIEW') {
        const viewDef = (await this.query(
          'SELECT view_definition FROM information_schema.views WHERE table_schema = current_schema() AND table_name = ?',
        ).get(t.table_name)) as any
        if (viewDef?.view_definition)
          dbConstraints[tName]._view = viewDef.view_definition
      }

      // is_identity/identity_generation are selected because an identity column
      // — what colDef() emits — carries a NULL column_default; only the legacy
      // serial style leaves a nextval(...) marker there.
      const cols = (await this.query(
        'SELECT column_name, data_type, is_nullable, column_default, udt_name, is_identity, identity_generation FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? ORDER BY ordinal_position',
      ).all(t.table_name)) as any[]

      for (const col of cols) {
        const primary = pkMap[t.table_name]?.has(col.column_name) || false
        dbConstraints[tName][Case.camel(col.column_name)] =
          this.parseConstraints(col, primary)
      }
    }
    return dbConstraints
  }

  async getIndexes(): Promise<SyncTypes.DBIndexes> {
    const rows = (await this.query(
      'SELECT indexname, indexdef, tablename FROM pg_indexes WHERE schemaname = current_schema()',
    ).all()) as any[]
    const dbIndexes: SyncTypes.DBIndexes = {}
    for (const r of rows) {
      if (
        !r.indexname ||
        r.indexname.endsWith('_pkey') ||
        /PRIMARY KEY/i.test(r.indexdef)
      )
        continue
      const m = r.indexdef.match(/\(([^)]+)\)/)
      dbIndexes[Case.camel(r.indexname)] = {
        type: /UNIQUE/i.test(r.indexdef) ? 'unique' : 'index',
        table: Case.camel(r.tablename),
        cols: m
          ? m[1]
              .split(',')
              .map((c: string) => Case.camel(c.trim().replace(/"/g, '')))
          : [],
      }
    }
    return dbIndexes
  }
  // Two patterns because Postgres does not store DDL text — it stores a parsed
  // expression and re-renders it, and how it renders depends on the version.
  // PG 14+ reports `(EXTRACT(epoch FROM now()))::integer`; PG <= 13 parses
  // EXTRACT into `date_part('epoch'::text, now())`, which the EXTRACT pattern
  // does not match. Missing it means the column diffs dirty on every single
  // sync — the same perpetual-rebuild failure the SQLite quote bug caused.
  override readonly dateNowDefaults: string[] = [
    'EXTRACT(EPOCH FROM',
    'DATE_PART',
  ]
  // The emitted expression is deliberately not `dateNowDefaults[0]`: that entry
  // is a match *prefix* for reading a default back out (Postgres re-renders the
  // expression, so the tail varies), and emitting it produced the unbalanced
  // `DEFAULT (EXTRACT(EPOCH FROM)`. Round trip: Postgres reports this back as
  // `(EXTRACT(epoch FROM now()))::integer`, which isDateNowDefault() strips
  // parens from and matches against the prefix above.
  override readonly dateNowExpression: string = 'EXTRACT(EPOCH FROM NOW())'

  protected override parseConstraints(
    col: any,
    primary = false,
  ): SyncTypes.ColumnConstraint {
    const cons: SyncTypes.ColumnConstraint = {
      type: PGAdapter.mapPgTypeToTsType(String(col.data_type || col.udt_name || '')),
    }
    if (primary) cons.primary = true
    if (PGAdapter.isAutoIncrement(col)) cons.autoIncrement = true
    if (col.is_nullable === 'YES' && !primary) cons.nullable = true

    let def = col.column_default
    if (
      typeof def === 'string' &&
      (def.replace(/[()'::\w]+$/, '').trim() === '%dateNow%' || def === '%dateNow%')
    ) {
      def = `'${def}'`
    } else {
      def = this.parseDefault(def)
    }
    if (def !== undefined) cons.default = def
    return cons
  }

  /**
   * Postgres spells auto-increment two ways, and they are mutually exclusive in
   * `information_schema.columns`.
   *
   * - Identity (`GENERATED ... AS IDENTITY`, what `colDef` emits): the sequence
   *   is a property of the column, so `column_default` is NULL and the fact
   *   lives in `is_identity` / `identity_generation`.
   * - Legacy `serial`: sugar for a plain column whose default is
   *   `nextval('<seq>'::regclass)`, with no identity flags at all.
   *
   * Checking only the second made the adapter report a Bakery-created primary
   * key as not auto-incrementing. `is_identity` is a `yes_or_no` domain, hence
   * the string compare; the boolean arm is there in case a driver coerces it.
   */
  private static isAutoIncrement(col: any): boolean {
    const identity = col?.is_identity
    if (identity === true) return true
    if (typeof identity === 'string' && identity.trim().toUpperCase() === 'YES')
      return true
    if (
      typeof col?.identity_generation === 'string' &&
      col.identity_generation.trim() !== ''
    )
      return true
    return (
      typeof col?.column_default === 'string' &&
      col.column_default.includes('nextval')
    )
  }

  private static readonly pgTypes = [
    {
      test: (t: string) =>
        t.includes('int') ||
        t.includes('serial') ||
        t.includes('bigint') ||
        t.includes('smallint'),
      type: 'integer' as const,
    },
    { test: (t: string) => t.includes('bool'), type: 'boolean' as const },
    { test: (t: string) => t.includes('bytea'), type: 'buffer' as const },
    {
      test: (t: string) =>
        t.includes('double') ||
        t.includes('real') ||
        t.includes('numeric') ||
        t.includes('decimal'),
      type: 'number' as const,
    },
  ]

  private static mapPgTypeToTsType(
    sqlType: string,
  ): SyncTypes.ColumnConstraint['type'] {
    const t = (sqlType || '').toLowerCase()
    for (const m of PGAdapter.pgTypes) {
      if (m.test(t)) return m.type
    }
    return 'string'
  }
}
