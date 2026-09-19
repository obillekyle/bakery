import path from 'node:path'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { Logger, messageLogger } from '@bakery-framework/core/logger'
import { Case, Try } from '@bakery-framework/core/utils'
import { SQL } from 'bun'
import type * as SyncTypes from '../sync/types'
import { createExecutor, SQLAdapter } from './base'

// Convention 4: logging is data, declared in a table rather than formatted at
// the call site.
const MESSAGES = messageLogger(new Logger('database'), {
  JOURNAL_WAL_REFUSED:
    'W SQLite refused WAL for %y{file}%* (answered %y{answer}%*) — running the %y{mode}%* journal instead. Expected on a network path; on a local disk it costs every write.',
  PRAGMA_FAILED:
    'W A SQLite performance pragma was rejected: %r{error}%*. The database works; it is not tuned.',
} as const)

export class SQLiteAdapter extends SQLAdapter {
  // SQLite's standard identifier quote. The base class defaults to MySQL's
  // backtick, which SQLite only tolerates as a compatibility extension.
  override readonly quoteChar: string = '"'

  protected readonly sql: SQL

  /**
   * Resolves when the performance pragmas have finished, or failed loudly.
   *
   * They are deliberately not awaited by every query the way `ready` is —
   * tuning is not correctness, and making the first statement of every process
   * wait on six round trips to gain nothing is the wrong trade. But `close()`
   * has to wait, because a handle closed underneath an in-flight pragma
   * rejects with `Connection closed`, and that is indistinguishable at the
   * catch from a filesystem genuinely refusing one. A short-lived adapter — a
   * test, a one-shot script — would otherwise warn on every close about a
   * failure that never happened.
   */
  protected readonly tuned: Promise<unknown> = Promise.resolve()

  /**
   * Resolves once `foreign_keys` is on, and every query awaits it.
   *
   * SQLite defaults the pragma OFF and it is per-connection, so without this a
   * FOREIGN KEY is stored, reported by `PRAGMA foreign_key_list`, shown in the
   * dashboard — and enforces nothing.
   *
   * Deliberately *not* in the performance pragma chain above it. That chain is
   * fire-and-forget by design (its own comment calls the statements
   * "unawaited"), which is fine for `cache_size`: applying late costs a little
   * speed. Applying `foreign_keys` late costs a row that was never checked, so
   * this one has to be something callers can wait on. A resolved promise after
   * the first query, so the cost is one microtask.
   */
  private readonly ready: Promise<unknown>
  private static readonly sqliteTypes: [
    string,
    SyncTypes.ColumnConstraint['type'],
  ][] = [
    ['BIGINT', 'bigint'],
    ['JSON', 'json'],
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
  /**
   * Normalize a stored view definition so it can be compared against the
   * schema's. Handles both quote styles: views created before the adapter used
   * `"` are still on disk with backticks.
   */
  private static cleanSQLQuotes(sql: string): string {
    return sql.replace(/`([^`]+)`|"([^"]+)"/g, (match, tick, dquote) => {
      const word = tick ?? dquote
      return !SQLiteAdapter.sqlKeywords.has(word.toUpperCase()) &&
        /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(word)
        ? word
        : match
    })
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
    // `sql` is supplied when wrapping an existing connection — notably once per
    // transaction. Setup below belongs only to a connection we open ourselves;
    // re-running it per transaction meant a mkdirSync plus six unawaited
    // PRAGMAs
    // racing against the transaction body on the same handle.
    const ownsConnection = sql === undefined

    if (ownsConnection && filename !== ':memory:') {
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
    // Every owned connection, `:memory:` included — the perf pragmas below
    // skip in-memory databases, but correctness does not get to.
    this.ready = ownsConnection
      ? this.sql.unsafe('PRAGMA foreign_keys = ON;')
      : Promise.resolve()

    if (ownsConnection && filename !== ':memory:') {
      const cacheSize = import.meta.env.THREAD_WORKER ? -1000 : -10000
      this.tuned = this.sql
        .unsafe('PRAGMA journal_mode = WAL;')
        .then((rows: unknown) => this.confirmWAL(rows, filename))
        .then(() => this.sql.unsafe('PRAGMA synchronous = NORMAL;'))
        .then(() => this.sql.unsafe('PRAGMA temp_store = memory;'))
        .then(() => this.sql.unsafe(`PRAGMA cache_size = ${cacheSize};`))
        .then(() => this.sql.unsafe('PRAGMA busy_timeout = 5000;'))
        .then(() => this.sql.unsafe('PRAGMA mmap_size = 0;'))
        // Not `catch(() => {})`. Every performance pragma failing silently is
        // how a database ends up running at a fraction of its speed with
        // nothing anywhere saying so, and convention 3 bans the bare form for
        // exactly this. These are tuning, not correctness — `foreign_keys`
        // above is awaited and is allowed to reject — so a failure is a
        // warning rather than a throw.
        .catch((error: Error) => {
          MESSAGES.PRAGMA_FAILED({ error: error.message })
        })
    }
  }

  /**
   * Waits for the pragma chain before closing the handle. See `tuned`.
   */
  override async close(): Promise<void> {
    await Try.catch(this.tuned)
    await super.close()
  }

  /**
   * **WAL first, DELETE only where WAL is actually refused.**
   *
   * The journal mode used to be `platform === 'win32' ? 'DELETE' : 'WAL'`, a
   * rule with no recorded reason. The hypothesis behind it was that a Windows
   * network path cannot host WAL, which is true — WAL needs a shared `-shm`
   * mapping that SMB and WebDAV do not provide — but the rule applied to every
   * Windows install, local disks included, where WAL works.
   *
   * Measured on this machine, four interleaved rounds against a CPU-bound
   * control that stayed flat at 29-34 ms:
   *
   *     single autocommit write    DELETE 3629 us    WAL 36 us      100x
   *     100-row transaction        DELETE 3.91 ms    WAL 0.13 ms     29x
   *
   * An attempt and a check replaces the rule, which is what makes it safe to
   * change without knowing why it was there. SQLite refuses WAL in two
   * observable ways and both are handled: it returns the *unchanged* mode in
   * the pragma's own result row (an in-memory database answers `memory`), or
   * it throws. Both shapes were reproduced before this was written, so the
   * fallback rests on a measurement rather than on the documentation.
   *
   * The same logic runs on the cache database in
   * `@bakery-framework/core/cache/shared-db`. It is deliberately not shared:
   * that site is synchronous `bun:sqlite` and this one is an async
   * `Bun.SQL`, so the control flow has nothing in common and only the
   * predicate would move — at the cost of a new published export subpath on a
   * surface that was closed on purpose before 2.0.0.
   */
  private async confirmWAL(rows: unknown, filename: string): Promise<void> {
    const first = Array.isArray(rows) ? rows[0] : undefined
    const answer = String(
      (first as { journal_mode?: unknown } | undefined)?.journal_mode ?? '',
    )
    if (answer.toLowerCase() === 'wal') return

    const fell = await this.sql.unsafe('PRAGMA journal_mode = DELETE;')
    const mode = Array.isArray(fell)
      ? String((fell[0] as { journal_mode?: unknown })?.journal_mode ?? 'unknown')
      : 'unknown'
    MESSAGES.JOURNAL_WAL_REFUSED({
      file: filename,
      answer: answer || '(no row)',
      mode,
    })
  }

  /**
   * `PRAGMA schema_version`, which is a counter SQLite bumps on every schema
   * change and leaves alone for every row change.
   *
   * Measured on a 50-table database: the full introspection the explorer runs
   * per write is **250 statements and 8.28 ms**, and this is **10.4 us** - 795x.
   * The semantics were checked rather than taken from the documentation: the
   * counter advances on `CREATE TABLE`, on `ALTER TABLE ... ADD COLUMN` and on
   * `DROP TABLE`, and does not move for an `INSERT`.
   *
   * Prefixed with the driver and the file so two different SQLite databases
   * cannot collide on the same small integer. A fresh database starts near
   * zero, so "version 3" is a value many of them hold at once.
   */
  override async schemaFingerprint(): Promise<string | null> {
    const row = (await this.query('PRAGMA schema_version').get()) as
      | { schema_version?: number }
      | null
      | undefined
    const version = row?.schema_version
    if (typeof version !== 'number') return null
    return `sqlite:${this.filename ?? ''}:${version}`
  }

  private static resolveFilename(rawValue?: string | null): string {
    const envVal = process.env.DATABASE_URL || process.env.SQLITE_PATH
    // `Bakery.dataDir`, not a literal: the default database file has to follow
    // the data directory, and this is the only place that names it.
    const fallback = path.resolve(Bakery.dataDir, 'server.db')
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
    async (sqlText: string, params: unknown[] = []) => {
      await this.ready
      return (await this.sql.unsafe(sqlText, params)) as SQLAdapter.RowRecord[]
    },
    async (
      sqlText: string,
      params: unknown[] = [],
    ): Promise<SQLAdapter.RunResult> => {
      await this.ready
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
    this.driver,
  )

  // `PRAGMA table_info('${table}')` interpolated the table name into a
  // string literal — a second SQL writer on a public adapter method, outside
  // the `qId`/`qRef`/`safeColumn` guards convention 8 makes the only ones.
  // The `pragma_table_info` table-valued function takes the same argument as a
  // bound parameter, so there is nothing left to quote; MySQL and Postgres
  // already bind theirs against `information_schema`.
  async hasCol(table: string, column: string): Promise<boolean> {
    const cols = (await this.query(`SELECT name FROM pragma_table_info(?)`).all(
      table,
    )) as SQLAdapter.NameRow[]
    return cols.some(c => c.name === column)
  }

  colDef(def: unknown, column?: string): string {
    const d = def as any
    const typeStr =
      {
        integer: 'INTEGER',
        string: 'TEXT',
        number: 'REAL',
        boolean: 'INTEGER',
        buffer: 'BLOB',
        bigint: 'BIGINT',
        json: 'JSON',
      }[d.type as string] || 'TEXT'
    // SQLite has no VARCHAR of its own — every text column is TEXT affinity —
    // but it stores the *declared* type verbatim and hands it back through
    // `pragma table_info`. Emitting the width is therefore free here and is
    // what lets one schema round-trip on all three dialects.
    let out =
      d.type === 'string' && typeof d.length === 'number'
        ? `VARCHAR(${d.length})`
        : typeStr
    if (d.primary) out += ' PRIMARY KEY'
    // SQLite accepts AUTOINCREMENT only on an INTEGER PRIMARY KEY and rejects
    // the whole CREATE TABLE otherwise, so the guard MySQL and Postgres apply
    // for tidiness is load-bearing here.
    if (d.autoIncrement && d.type === 'integer') out += ' AUTOINCREMENT'
    if (!d.nullable && !d.primary) out += ' NOT NULL'
    // The CHECK names the column, which is why colDef takes it. Emitted only
    // when both are known: an ALTER path that has no name yet gets a plain
    // sized column rather than a syntax error.
    const check =
      Array.isArray(d._enum) && d._enum.length && column
        ? this.enumClause(column, d._enum)
        : ''
    return out + this.formatDefault(d.default, '1', '0') + check
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

  protected withConnection(sql: unknown): SQLAdapter {
    return new SQLiteAdapter(this.filename, sql as SQL)
  }

  async getSchema(
    options?: SQLAdapter.SchemaOptions,
  ): Promise<SQLAdapter.TableDetails[]> {
    const res = (await this.query(
      'SELECT name FROM sqlite_master' +
        " WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all()) as SQLAdapter.NameRow[]
    // Per table rather than per wave: the three queries below were already
    // concurrent, but the loop around them awaited each table in turn, so a
    // 20-table schema cost 20 sequential round-trip waves. They share nothing,
    // so the whole fan-out is one wave now.
    //
    // The `COUNT(*)` is a full scan on this dialect and on Postgres, so it is
    // opt-in: only a schema *listing* displays the number, and `getSchema()`
    // also sits on the explorer's write path, where a count nobody shows cost
    // a scan of every table per write.
    return await Promise.all(
      res.map(async t => {
        const tableName = this.quote(t.name)

        const [countRes, cols, idxs] = (await Promise.all([
          options?.rowCounts
            ? this.query(`SELECT COUNT(*) as count FROM ${tableName}`).get()
            : null,
          this.query(`PRAGMA table_info(${tableName})`).all(),
          this.query(`PRAGMA index_list(${tableName})`).all(),
        ])) as [SQLAdapter.CountRow | null, any[], any[]]

        return {
          name: t.name,
          rowCount: options?.rowCounts ? countRes?.count || 0 : null,
          columns: cols.map(c => ({
            name: c.name,
            type: c.type,
            notnull: c.notnull === 1,
            // `pk` is the column's **1-based position within the primary key**,
            // not a boolean — `PRAGMA table_info` reports 0 for "not part of the
            // key", 1 for the first key column, 2 for the second. So `=== 1`
            // reported a composite `PRIMARY KEY (a, b)` as a single-column key on
            // `a`, silently, and only on SQLite: MySQL reads `column_key = 'PRI'`
            // and Postgres reads `pg_index.indisprimary`, both of which are set on
            // every member.
            //
            // `parseConstraints` a few hundred lines down already had this right
            // (`col.pk > 0`), which is why `getConstraints()` disagreed with
            // `getSchema()` about the same table.
            pk: c.pk > 0,
          })),
          indexes: idxs.map(i => ({ name: i.name, unique: i.unique === 1 })),
        }
      }),
    )
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

    // See `TableDataOptions.knownTotal`: the count is 97% of a page's cost,
    // and a caller that has already counted can say so.
    const reuse = SQLAdapter.usableTotal(options.knownTotal)

    const [countRes, rows] = (await Promise.all([
      reuse
        ? Promise.resolve(null)
        : this.query(`SELECT COUNT(*) as count FROM ${tname}${whereSql}`).get(
            ...whereParams,
          ),
      this.query(
        `SELECT rowid AS rowid, * FROM ${tname}` +
          `${whereSql}${orderSql} LIMIT ? OFFSET ?`,
      ).all(...whereParams, pageSize, (page - 1) * pageSize),
    ])) as [SQLAdapter.CountRow | null, any[]]

    const totalRows = reuse ? options.knownTotal! : countRes?.count || 0
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

  override async getForeignKeys(): Promise<SyncTypes.DBForeignKeys> {
    const out: SyncTypes.DBForeignKeys = {}
    const tables = await this.getSchema()
    for (const t of tables) {
      // PRAGMA takes an identifier, not a bound parameter.
      const rows = (await this.query(
        `PRAGMA foreign_key_list(${this.quote(t.name)})`,
      ).all()) as any[]
      // One row per column, grouped by `id` for a composite key.
      const byId = new Map<
        number,
        {
          cols: string[]
          refCols: string[]
          refTable: string
          onDelete: SyncTypes.ForeignKeyAction
          onUpdate: SyncTypes.ForeignKeyAction
        }
      >()
      for (const r of rows) {
        const id = Number(r.id ?? 0)
        const g = byId.get(id) ?? {
          cols: [] as string[],
          refCols: [] as string[],
          refTable: String(r.table),
          onDelete: SQLAdapter.normalizeForeignKeyAction(r.on_delete),
          onUpdate: SQLAdapter.normalizeForeignKeyAction(r.on_update),
        }
        g.cols.push(String(r.from))
        g.refCols.push(String(r.to))
        byId.set(id, g)
      }
      for (const g of byId.values()) {
        const fk = {
          table: t.name,
          cols: g.cols,
          refTable: g.refTable,
          refCols: g.refCols,
          onDelete: g.onDelete,
          onUpdate: g.onUpdate,
        }
        out[SQLAdapter.foreignKeyId(fk)] = fk
      }
    }
    return out
  }

  /**
   * SQLite has no `ALTER TABLE ADD/DROP FOREIGN KEY`: the constraint lives in
   * the table definition, so changing one means rebuilding the table. The
   * planner reads this and schedules a rebuild instead of emitting DDL that
   * would fail.
   */
  override get supportsAlterForeignKey(): boolean {
    return false
  }

  /**
   * SQLite has `UNION ALL` but neither `INTERSECT ALL` nor `EXCEPT ALL` — the
   * `ALL` modifier is only accepted after `UNION`.
   */
  override get supportsSetOperationAll(): boolean {
    return false
  }

  async getConstraints(): Promise<SyncTypes.DBConstraints> {
    const tables = (await this.query(
      'SELECT sql,name,type FROM sqlite_master' +
        " WHERE (type='table' OR type='view')" +
        " AND name NOT LIKE 'sqlite_%'",
    ).all()) as any[]

    const dbConstraints: SyncTypes.DBConstraints = {}

    for (const table of tables) {
      const tName = Case.camel(table.name)
      dbConstraints[tName] = {} as SyncTypes.TableConstraints

      // Bound, not interpolated — the same conversion `hasCol` above
      // records. This one survived it: `getConstraints` runs over every table
      // the database reports, so a name carrying an apostrophe closed the
      // literal and the rest of the statement went with it.
      const cols = (await this.query(
        'SELECT * FROM pragma_table_info(?)',
      ).all(table.name)) as any[]

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
      'SELECT name, tbl_name, sql FROM sqlite_master' +
        " WHERE type='index' AND sql IS NOT NULL" +
        " AND name NOT LIKE 'sqlite_autoindex_%'",
    ).all()) as any[]
    return Object.fromEntries(
      await Promise.all(
        indexes.map(async idx => {
          // Bound for the same reason as `getConstraints` above: an index
          // name comes from `sqlite_master`, not from this codebase.
          const raw = (
            (await this.query('SELECT * FROM pragma_index_info(?)').all(
              idx.name,
            )) as any[]
          ).map(c => String(c.name))
          return [
            Case.camel(idx.name),
            {
              type: idx.sql.toUpperCase().includes('UNIQUE')
                ? 'unique'
                : 'index',
              table: Case.camel(idx.tbl_name),
              cols: raw.map(Case.camel),
              rawCols: raw,
            },
          ]
        }),
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
  override readonly dateNowExpression: string =
    "CAST(strftime('%s', 'now') AS INTEGER)"

  /**
   * SQLite has no UUID function, so the canonical 8-4-4-4-12 form is assembled
   * from `randomblob(16)`. Version and variant nibbles are **not** forced, so
   * this is a random 128-bit value in UUID shape rather than a conforming v4 —
   * unique, but do not hand it to something that validates the version field.
   *
   * SQLite stores the default expression verbatim and hands it back the same
   * way, so the emitted form and the match pattern are the same string.
   */
  override readonly uuidExpression: string =
    "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-' || " +
    "hex(randomblob(2)) || '-' || hex(randomblob(2)) || '-' || " +
    'hex(randomblob(6)))'
  override readonly uuidDefaults: string[] = [this.uuidExpression]

  protected override parseConstraints(
    col: any,
    tableSql = '',
  ): SyncTypes.ColumnConstraint {
    const primary = col.pk > 0
    const cons: SyncTypes.ColumnConstraint = {
      type: SQLiteAdapter.mapSqlToTsType(col.type),
    }

    // SQLite has no catalog column for width; it stores the *declared* type
    // verbatim and hands it back through `pragma table_info`, so the number is
    // in the type string — 'VARCHAR(64)'. That is also why emitting the width
    // is worth doing on a dialect with no real VARCHAR: it is what lets one
    // schema round-trip on all three.
    const declared = String(col.type || '')
    const length = this.sizedTextLength(
      declared,
      /\((\d+)\)/.exec(declared)?.[1],
    )
    if (length !== undefined) cons.length = length

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

  // `protected override`, not `private`: narrowing a base member's visibility
  // is TS2415, and it made SQLiteAdapter fail to satisfy SQLAdapter — so the
  // one adapter with real test coverage did not typecheck against the contract
  // the two untested ones share.
  protected override parseDefault(def: any): any {
    if (def === null || def === undefined) return def
    const isStr = typeof def === 'string'
    if (isStr && (def.startsWith("'") || def.startsWith('"'))) {
      const quote: string = def[0]
      const unquoted = def.slice(1, -1)
      if (unquoted === '%dateNow%') return def
      // sqlite_master hands back the literal exactly as formatDefault wrote it,
      // so the quote it doubled per SQL rules is still doubled. Stripping the
      // delimiters without collapsing it leaves `it''s fine` where the schema
      // says `it's fine` — drift diffColumnMismatch can never resolve, and a
      // table rebuild on every db:sync as a result.
      return unquoted.replaceAll(quote + quote, quote)
    }
    return super.parseDefault(def)
  }
}
