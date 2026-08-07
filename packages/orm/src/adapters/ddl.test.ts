import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { SQLAdapter } from './base'
import { MySQLAdapter } from './mysql'
import { PGAdapter } from './pgsql'
import { SQLiteAdapter } from './sqlite'

/**
 * DDL emission and introspection, per dialect.
 *
 * `contract.test.ts` covers identifier quoting and the Postgres placeholder
 * scanner. This file covers the two surfaces above them: the DDL each adapter
 * *writes*, and the introspection queries it *reads back*. Those are where a
 * dialect bug actually lives — a wrong type mapping, an `information_schema`
 * column that does not exist, a clause in the wrong order.
 *
 * There is no MySQL or Postgres server here, and there does not need to be for
 * most of it. Every adapter funnels its SQL through `this.sql.unsafe(sql,
 * params)`, so replacing that one handle with a recorder captures the exact
 * text the server would have received — after Postgres normalisation, after
 * `RETURNING *` injection, with the real parameter list. What that cannot check
 * is whether the server accepts it; those assertions are marked as such, and
 * SQLite runs for real instead.
 *
 * A handful of tests are named `BUG:`. They pin behaviour that is *wrong* so
 * that it is visible and greppable rather than silently shipped; each says what
 * the correct behaviour would be. Fixing one should break its test.
 */

interface Recorded {
  sql: string
  params: unknown[]
}

/** Rows to return for a given statement. Throwing simulates a server error. */
type Respond = (sql: string, params: unknown[]) => unknown

/** Adapters whose driver handle was swapped, with the handle to put back. */
const swapped: Array<() => void> = []

/**
 * Swap an adapter's driver handle for a recorder.
 *
 * Not `mock.module`: that is process-global and never restored, so one file
 * using it corrupts every file Bun happens to load afterwards. This reaches
 * into a single object and puts the original back in `afterAll`.
 */
function record(adapter: SQLAdapter, respond: Respond = () => []): Recorded[] {
  const holder = adapter as unknown as { sql: unknown }
  const original = holder.sql
  swapped.push(() => {
    holder.sql = original
  })

  const calls: Recorded[] = []
  holder.sql = {
    unsafe: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params })
      return respond(sql, params)
    },
  }
  return calls
}

const texts = (calls: Recorded[]) => calls.map(c => c.sql)

/** SQLite adapters opened only to record their SQL; closed at the end. */
const recorded: SQLiteAdapter[] = []
function sqliteRecorder(respond?: Respond): [SQLiteAdapter, Recorded[]] {
  const db = new SQLiteAdapter(':memory:')
  recorded.push(db)
  return [db, record(db, respond)]
}

afterAll(async () => {
  for (const restore of swapped) restore()
  for (const db of recorded) await db.close()
})

/** The five types a Bakery schema column can declare. */
const TYPES = ['integer', 'string', 'number', 'boolean', 'buffer'] as const

/** True when every `(` in `sql` has a matching `)`. */
function parensBalanced(sql: string): boolean {
  let depth = 0
  for (const char of sql) {
    if (char === '(') depth++
    else if (char === ')') depth--
    if (depth < 0) return false
  }
  return depth === 0
}

describe('colDef maps the schema type set onto each dialect', () => {
  // The expected lists are written out per dialect rather than derived from the
  // adapter, so a type mapping cannot agree with itself.
  test('SQLite uses storage classes', () => {
    const db = new SQLiteAdapter(':memory:')
    recorded.push(db)
    expect(TYPES.map(type => db.colDef({ type, nullable: true }))).toEqual([
      'INTEGER',
      'TEXT',
      'REAL',
      'INTEGER',
      'BLOB',
    ])
  })

  test('MySQL uses INT/DOUBLE/TINYINT(1)', () => {
    const db = new MySQLAdapter()
    expect(TYPES.map(type => db.colDef({ type, nullable: true }))).toEqual([
      'INT',
      'TEXT',
      'DOUBLE',
      'TINYINT(1)',
      'BLOB',
    ])
  })

  test('Postgres uses DOUBLE PRECISION/BOOLEAN/BYTEA', () => {
    const db = new PGAdapter()
    expect(TYPES.map(type => db.colDef({ type, nullable: true }))).toEqual([
      'INTEGER',
      'TEXT',
      'DOUBLE PRECISION',
      'BOOLEAN',
      'BYTEA',
    ])
  })

  test('an unrecognised type falls back to TEXT, not to nothing', () => {
    // The fallback matters: an empty type string produces `"col"  NOT NULL`,
    // which every dialect rejects.
    const db = new SQLiteAdapter(':memory:')
    recorded.push(db)
    // Not 'json' — that is a real schema type now, mapping to JSON/JSONB. This
    // needs a name the map genuinely does not know.
    expect(db.colDef({ type: 'geometry' })).toBe('TEXT NOT NULL')
    expect(new MySQLAdapter().colDef({ type: 'geometry' })).toBe('TEXT NOT NULL')
    expect(new PGAdapter().colDef({ type: 'geometry' })).toBe('TEXT NOT NULL')
  })
})

describe('colDef emits each dialect s auto-increment spelling', () => {
  const def = { type: 'integer', primary: true, autoIncrement: true }

  test('SQLite puts AUTOINCREMENT after PRIMARY KEY', () => {
    // Order is not cosmetic — SQLite only accepts AUTOINCREMENT immediately
    // after PRIMARY KEY, and MySQL only accepts AUTO_INCREMENT before it.
    const db = new SQLiteAdapter(':memory:')
    recorded.push(db)
    expect(db.colDef(def)).toBe('INTEGER PRIMARY KEY AUTOINCREMENT')
  })

  test('MySQL puts AUTO_INCREMENT before PRIMARY KEY', () => {
    expect(new MySQLAdapter().colDef(def)).toBe('INT AUTO_INCREMENT PRIMARY KEY')
  })

  test('Postgres uses an identity column, not a serial', () => {
    expect(new PGAdapter().colDef(def)).toBe(
      'INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
    )
  })

  test('MySQL and Postgres ignore autoIncrement on a non-integer', () => {
    const nonInt = { type: 'string', primary: true, autoIncrement: true }
    expect(new MySQLAdapter().colDef(nonInt)).toBe('TEXT PRIMARY KEY')
    expect(new PGAdapter().colDef(nonInt)).toBe('TEXT PRIMARY KEY')
  })
})

describe('colDef renders defaults per dialect', () => {
  const dialects = () =>
    [
      ['sqlite', new SQLiteAdapter(':memory:')],
      ['mysql', new MySQLAdapter()],
      ['postgres', new PGAdapter()],
    ] as const

  test('booleans are 1/0 in SQLite and MySQL, TRUE/FALSE in Postgres', () => {
    const [[, lite], [, my], [, pg]] = dialects()
    recorded.push(lite as SQLiteAdapter)
    const on = { type: 'boolean', nullable: true, default: true }
    const off = { type: 'boolean', nullable: true, default: false }

    expect(lite.colDef(on)).toBe('INTEGER DEFAULT 1')
    expect(lite.colDef(off)).toBe('INTEGER DEFAULT 0')
    expect(my.colDef(on)).toBe('TINYINT(1) DEFAULT 1')
    expect(my.colDef(off)).toBe('TINYINT(1) DEFAULT 0')
    expect(pg.colDef(on)).toBe('BOOLEAN DEFAULT TRUE')
    expect(pg.colDef(off)).toBe('BOOLEAN DEFAULT FALSE')
  })

  test('a string default is single-quoted with embedded quotes doubled', () => {
    for (const [, db] of dialects()) {
      if (db instanceof SQLiteAdapter) recorded.push(db)
      expect(db.colDef({ type: 'string', nullable: true, default: "it's" })).toContain(
        "DEFAULT 'it''s'",
      )
    }
  })

  test('null and numeric defaults render unquoted', () => {
    for (const [, db] of dialects()) {
      if (db instanceof SQLiteAdapter) recorded.push(db)
      expect(db.colDef({ type: 'integer', nullable: true, default: null })).toContain(
        'DEFAULT NULL',
      )
      expect(db.colDef({ type: 'number', nullable: true, default: 1.5 })).toContain(
        'DEFAULT 1.5',
      )
    }
  })

  test('an undefined default adds no DEFAULT clause at all', () => {
    for (const [, db] of dialects()) {
      if (db instanceof SQLiteAdapter) recorded.push(db)
      expect(db.colDef({ type: 'string', nullable: true })).not.toContain('DEFAULT')
    }
  })
})

/**
 * Most DDL lives on the base class, so the only thing that should differ
 * between dialects is the quote character. The expected quote is written as a
 * literal in the table below rather than read off the adapter — otherwise a
 * wrong `quoteChar` would agree with itself and the test would pass.
 */
describe('shared DDL differs only in the quote character', () => {
  const shapes = [
    { name: 'sqlite', q: '"', make: () => new SQLiteAdapter(':memory:') },
    { name: 'mysql', q: '`', make: () => new MySQLAdapter() },
    { name: 'postgres', q: '"', make: () => new PGAdapter() },
  ] as const

  for (const { name, q, make } of shapes) {
    test(`${name}: ALTER TABLE ... ADD COLUMN`, async () => {
      const db = make()
      if (db instanceof SQLiteAdapter) recorded.push(db)
      const calls = record(db)
      await db.addCol('app_users', 'nick_name', { type: 'string', nullable: true })
      expect(texts(calls)).toEqual([
        `ALTER TABLE ${q}app_users${q} ADD COLUMN ${q}nick_name${q} TEXT`,
      ])
    })

    test(`${name}: DROP TABLE/VIEW/COLUMN`, async () => {
      const db = make()
      if (db instanceof SQLiteAdapter) recorded.push(db)
      const calls = record(db)
      await db.drop('TABLE', 'app_users')
      await db.drop('VIEW', 'active_users')
      await db.drop('COLUMN', 'app_users', 'nick_name')
      expect(texts(calls)).toEqual([
        `DROP TABLE IF EXISTS ${q}app_users${q}`,
        `DROP VIEW IF EXISTS ${q}active_users${q}`,
        `ALTER TABLE ${q}app_users${q} DROP COLUMN ${q}nick_name${q}`,
      ])
    })

    test(`${name}: CREATE TABLE, with and without IF NOT EXISTS`, async () => {
      const db = make()
      if (db instanceof SQLiteAdapter) recorded.push(db)
      const calls = record(db)
      await db.createTable('app_users', ['a INT', 'b TEXT'])
      await db.createTable('app_users', ['a INT'], true)
      expect(texts(calls)).toEqual([
        `CREATE TABLE ${q}app_users${q} (\na INT,\nb TEXT\n)`,
        `CREATE TABLE IF NOT EXISTS ${q}app_users${q} (\na INT\n)`,
      ])
    })

    test(`${name}: CREATE VIEW drops the old definition first`, async () => {
      // A view is replaced, not altered; skipping the drop makes every sync
      // after the first fail with "view already exists".
      const db = make()
      if (db instanceof SQLiteAdapter) recorded.push(db)
      const calls = record(db)
      await db.createView('active_users', 'SELECT 1')
      expect(texts(calls)).toEqual([
        `DROP VIEW IF EXISTS ${q}active_users${q}`,
        `CREATE VIEW ${q}active_users${q} AS SELECT 1`,
      ])
    })

    test(`${name}: copyTableData quotes both sides`, async () => {
      const db = make()
      if (db instanceof SQLiteAdapter) recorded.push(db)
      const calls = record(db)
      await db.copyTableData('app_users_old', 'app_users', ['id', 'nick_name'])
      // Postgres appends RETURNING * to anything starting INSERT INTO; asserted
      // on its own below.
      expect(texts(calls)[0]).toContain(
        `INSERT INTO ${q}app_users${q} (${q}id${q}, ${q}nick_name${q}) SELECT ${q}id${q}, ${q}nick_name${q} FROM ${q}app_users_old${q}`,
      )
    })
  }
})

describe('TRUNCATE is a different statement in every dialect', () => {
  test('SQLite has none, so it deletes and vacuums', async () => {
    const [db, calls] = sqliteRecorder()
    await db.truncate('app_users')
    expect(texts(calls)).toEqual(['DELETE FROM "app_users"', 'VACUUM'])
  })

  test('MySQL uses TRUNCATE TABLE', async () => {
    const db = new MySQLAdapter()
    const calls = record(db)
    await db.truncate('app_users')
    expect(texts(calls)).toEqual(['TRUNCATE TABLE `app_users`'])
  })

  test('Postgres also restarts identities and cascades', async () => {
    // Without RESTART IDENTITY the next insert reuses the old sequence value;
    // without CASCADE the truncate fails whenever anything references the table.
    const db = new PGAdapter()
    const calls = record(db)
    await db.truncate('app_users')
    expect(texts(calls)).toEqual([
      'TRUNCATE TABLE "app_users" RESTART IDENTITY CASCADE',
    ])
  })
})

describe('row identity differs per dialect', () => {
  test('SQLite addresses rows by rowid', async () => {
    const [db, calls] = sqliteRecorder()
    await db.remove('app_users', 7)
    await db.update('app_users', 7, { nick_name: 'x' })
    expect(calls[0]).toEqual({
      sql: 'DELETE FROM "app_users" WHERE rowid = ?',
      params: [7],
    })
    expect(calls[1].sql.replace(/\s+/g, ' ')).toBe(
      'UPDATE "app_users" SET "nick_name" = ? WHERE rowid = ?',
    )
    expect(calls[1].params).toEqual(['x', 7])
  })

  test('Postgres addresses rows by ctid', async () => {
    const db = new PGAdapter()
    const calls = record(db)
    await db.remove('app_users', '(0,1)')
    await db.update('app_users', '(0,1)', { nick_name: 'x' })
    expect(calls[0]).toEqual({
      sql: 'DELETE FROM "app_users" WHERE ctid::text = $1',
      params: ['(0,1)'],
    })
    expect(calls[1]).toEqual({
      sql: 'UPDATE "app_users" SET "nick_name" = $1 WHERE ctid::text = $2',
      params: ['x', '(0,1)'],
    })
  })

  test('MySQL has neither, so it looks the primary key up first', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables')) return [{ name: 'app_users' }]
      if (sql.includes('COUNT(*)')) return [{ count: 0 }]
      if (sql.includes('information_schema.columns'))
        return [{ name: 'user_id', type: 'int', is_nullable: 'NO', column_key: 'PRI' }]
      return []
    })
    await db.remove('app_users', 7)
    expect(calls[calls.length - 1]).toEqual({
      sql: 'DELETE FROM `app_users` WHERE `user_id` = ?',
      params: [7],
    })
  })

  test('MySQL falls back to `id` when no primary key is reported', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql =>
      sql.includes('information_schema.tables') ? [{ name: 'app_users' }] : [],
    )
    await db.remove('app_users', 7)
    expect(calls[calls.length - 1].sql).toBe(
      'DELETE FROM `app_users` WHERE `id` = ?',
    )
  })

  test('MySQL looks the key up with one targeted query, not a whole-schema scan', async () => {
    // `remove`/`update` used to call getSchema(), which lists every table and
    // then issues COUNT(*) plus two information_schema queries *per table* — so
    // deleting one row from a 20-table database ran 61 statements, 20 of them
    // full row counts, to learn one column name. The pk is one lookup.
    const db = new MySQLAdapter()
    const calls = record(db, sql =>
      sql.includes('information_schema.columns')
        ? [{ name: 'user_id' }]
        : [{ name: 'app_users' }],
    )

    await db.remove('app_users', 7)
    await db.update('app_users', 7, { nick_name: 'x' })

    expect(texts(calls).filter(sql => /COUNT\(\*\)/i.test(sql))).toEqual([])
    expect(texts(calls).filter(sql => sql.includes('information_schema.tables'))).toEqual([])
    // One key lookup per statement, and nothing else.
    expect(calls).toHaveLength(4)
    expect(calls[1]).toEqual({
      sql: 'DELETE FROM `app_users` WHERE `user_id` = ?',
      params: [7],
    })
    expect(calls[3]).toEqual({
      sql: 'UPDATE `app_users` SET `nick_name` = ? WHERE `user_id` = ?',
      params: ['x', 7],
    })
  })
})

describe('index DDL diverges on MySQL', () => {
  test('SQLite and Postgres use CREATE [UNIQUE] INDEX', async () => {
    const [lite, liteCalls] = sqliteRecorder()
    await lite.createIndex('idx_name', 'app_users', ['nick_name'], true)
    await lite.createIndex('idx_pair', 'app_users', ['first_name', 'last_name'])
    expect(texts(liteCalls)).toEqual([
      'CREATE UNIQUE INDEX "idx_name" ON "app_users" ("nick_name")',
      'CREATE INDEX "idx_pair" ON "app_users" ("first_name", "last_name")',
    ])

    const pg = new PGAdapter()
    const pgCalls = record(pg)
    await pg.createIndex('idx_name', 'app_users', ['nick_name'], true)
    expect(texts(pgCalls)).toEqual([
      'CREATE UNIQUE INDEX "idx_name" ON "app_users" ("nick_name")',
    ])
  })

  test('MySQL uses ALTER TABLE ... ADD INDEX', async () => {
    // MySQL index names are scoped to the table, so the statement has to name
    // the table; `CREATE INDEX x ON t` also works but ALTER is what sync emits.
    const db = new MySQLAdapter()
    const calls = record(db)
    await db.createIndex('idx_name', 'app_users', ['nick_name'], true)
    await db.createIndex('idx_pair', 'app_users', ['first_name', 'last_name'])
    expect(texts(calls)).toEqual([
      'ALTER TABLE `app_users` ADD UNIQUE INDEX `idx_name` (`nick_name`)',
      'ALTER TABLE `app_users` ADD INDEX `idx_pair` (`first_name`, `last_name`)',
    ])
  })

  test('MySQL resolves the owning table before dropping an index', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql =>
      sql.includes('information_schema.statistics')
        ? [{ table_name: 'app_users' }]
        : [],
    )
    await db.drop('INDEX', 'idx_name')
    expect(calls[0]).toEqual({
      sql: 'SELECT DISTINCT table_name AS table_name FROM information_schema.statistics WHERE index_name = ? AND table_schema = DATABASE()',
      params: ['idx_name'],
    })
    expect(calls[1].sql).toBe('DROP INDEX `idx_name` ON `app_users`')
  })

  test('MySQL turns a failed index drop into a thrown error', async () => {
    // A silent `changes: 0` would let the sync plan record the index as gone
    // while it is still there, and the next run would try to create it again.
    const db = new MySQLAdapter()
    record(db, sql => {
      if (sql.startsWith('DROP INDEX')) throw new Error('errno 1091')
      return []
    })
    await expect(db.drop('INDEX', 'idx_name')).rejects.toThrow(
      'Failed to drop index idx_name: errno 1091',
    )
  })

  test('SQLite and Postgres drop an index by name alone', async () => {
    const [lite, liteCalls] = sqliteRecorder()
    await lite.drop('INDEX', 'idx_name')
    expect(texts(liteCalls)).toEqual(['DROP INDEX IF EXISTS "idx_name"'])

    const pg = new PGAdapter()
    const pgCalls = record(pg)
    await pg.drop('INDEX', 'idx_name')
    expect(texts(pgCalls)).toEqual(['DROP INDEX IF EXISTS "idx_name"'])
  })
})

describe('rename DDL diverges on MySQL', () => {
  test('SQLite and Postgres use ALTER TABLE ... RENAME', async () => {
    const [lite, liteCalls] = sqliteRecorder()
    await lite.rename('TABLE', 'old_users', 'app_users')
    await lite.rename('COLUMN', 'app_users', 'old_col', 'nick_name')
    expect(texts(liteCalls)).toEqual([
      'ALTER TABLE "old_users" RENAME TO "app_users"',
      'ALTER TABLE "app_users" RENAME COLUMN "old_col" TO "nick_name"',
    ])
  })

  test('MySQL renames a table with RENAME TABLE', async () => {
    const db = new MySQLAdapter()
    const calls = record(db)
    await db.rename('TABLE', 'old_users', 'app_users')
    expect(texts(calls)).toEqual(['RENAME TABLE `old_users` TO `app_users`'])
  })

  test('MySQL falls back to CHANGE when RENAME COLUMN is unsupported', async () => {
    // RENAME COLUMN arrived in MySQL 8.0; on anything older the only spelling
    // is CHANGE, which has to restate the column's full definition.
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('RENAME COLUMN')) throw new Error('syntax error')
      if (sql.includes('information_schema.columns'))
        return [
          {
            column_type: 'varchar(64)',
            is_nullable: 'NO',
            column_default: null,
            extra: 'auto_increment',
          },
        ]
      return []
    })

    await db.rename('COLUMN', 'app_users', 'old_col', 'nick_name')

    expect(calls[1]).toEqual({
      sql: 'SELECT column_type AS column_type, is_nullable AS is_nullable, column_default AS column_default, extra AS extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      params: ['app_users', 'old_col'],
    })
    expect(calls[2].sql).toBe(
      'ALTER TABLE `app_users` CHANGE `old_col` `nick_name` varchar(64) NOT NULL auto_increment',
    )
  })

  test('the CHANGE fallback keeps a nullable column nullable', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('RENAME COLUMN')) throw new Error('syntax error')
      if (sql.includes('information_schema.columns'))
        return [{ column_type: 'text', is_nullable: 'YES', column_default: null, extra: '' }]
      return []
    })
    await db.rename('COLUMN', 'app_users', 'old_col', 'nick_name')
    expect(calls[2].sql).toBe(
      'ALTER TABLE `app_users` CHANGE `old_col` `nick_name` text',
    )
  })
})

describe('Postgres rewrites DDL and DML on the way out', () => {
  test('an INSERT gains RETURNING * so lastInsertRowid can exist', async () => {
    // Postgres has no lastInsertRowid; the adapter reads the first column of
    // the returned row instead, which only works if the row comes back.
    const db = new PGAdapter()
    const calls = record(db, () => [{ id: 42 }])
    const result = await db.insert('appUsers', { firstName: 'ann' })
    expect(calls[0]).toEqual({
      sql: 'INSERT INTO "app_users" ("first_name") VALUES ($1) RETURNING *',
      params: ['ann'],
    })
    expect(result.lastInsertRowid).toBe(42)
  })

  test('an INSERT that already returns is not given a second RETURNING', async () => {
    const db = new PGAdapter()
    const calls = record(db, () => [])
    await db.query('INSERT INTO "t" ("a") VALUES (?) RETURNING "a"').run(1)
    expect(calls[0].sql).toBe('INSERT INTO "t" ("a") VALUES ($1) RETURNING "a"')
  })

  test('non-INSERT DDL is left alone apart from placeholder rewriting', async () => {
    const db = new PGAdapter()
    const calls = record(db)
    await db.createTable('app_users', ['"id" INTEGER'])
    expect(calls[0].sql).toBe('CREATE TABLE "app_users" (\n"id" INTEGER\n)')
  })

  test('the base insert snake-cases the table and every column', async () => {
    // Shared with the other dialects, but only visible once something records
    // the statement: the ORM speaks camelCase and the database does not.
    const [db, calls] = sqliteRecorder()
    await db.insert('ecrStudentEntry', [
      { studentName: 'ann' },
      { studentName: 'bob', gradeLevel: 2 },
    ])
    expect(calls[0]).toEqual({
      sql: 'INSERT INTO "ecr_student_entry" ("student_name", "grade_level") VALUES (?, ?), (?, ?)',
      params: ['ann', null, 'bob', 2],
    })
  })

  test('insert with mapSnake off leaves the keys as given', async () => {
    const [db, calls] = sqliteRecorder()
    await db.insert('ecr_student_entry', { studentName: 'ann' }, false)
    expect(calls[0].sql).toBe(
      'INSERT INTO "ecr_student_entry" ("studentName") VALUES (?)',
    )
  })

  test('inserting nothing issues no statement at all', async () => {
    const [db, calls] = sqliteRecorder()
    expect(await db.insert('app_users', [])).toEqual({
      lastInsertRowid: null,
      changes: 0,
    })
    expect(calls).toEqual([])
  })
})

describe('MySQL introspection queries', () => {
  test('hasCol reads information_schema scoped to the current database', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, () => [{ column_name: 'nick_name' }])
    expect(await db.hasCol('app_users', 'nick_name')).toBe(true)
    expect(await db.hasCol('app_users', 'absent')).toBe(false)
    expect(calls[0]).toEqual({
      sql: 'SELECT column_name AS column_name FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()',
      params: ['app_users'],
    })
  })

  test('getConstraints reads tables then columns, and camelCases both', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ table_name: 'app_users', table_type: 'BASE TABLE' }]
      if (sql.includes('information_schema.columns'))
        return [
          {
            column_name: 'id',
            column_type: 'int(11)',
            data_type: 'int',
            is_nullable: 'NO',
            column_key: 'PRI',
            column_default: null,
            extra: 'auto_increment',
          },
          {
            column_name: 'nick_name',
            column_type: 'varchar(64)',
            data_type: 'varchar',
            is_nullable: 'YES',
            column_key: '',
            column_default: 'anon',
            extra: '',
          },
        ]
      return []
    })

    expect(await db.getConstraints()).toEqual({
      appUsers: {
        id: { type: 'integer', primary: true, autoIncrement: true, default: null },
        nickName: { type: 'string', nullable: true, default: 'anon' },
      },
    })
    expect(texts(calls)).toEqual([
      "SELECT table_name AS table_name, table_type AS table_type FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type IN ('BASE TABLE','VIEW')",
      'SELECT column_name AS column_name, column_type AS column_type, data_type AS data_type, is_nullable AS is_nullable, column_key AS column_key, column_default AS column_default, extra AS extra FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position',
    ])
  })

  test('getConstraints pulls a view body from information_schema.views', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ table_name: 'active_users', table_type: 'VIEW' }]
      if (sql.includes('information_schema.views'))
        return [{ view_definition: 'select `id` from `app_users`' }]
      return []
    })
    const constraints = await db.getConstraints()
    expect(constraints.activeUsers._view).toBe('select `id` from `app_users`')
    expect(texts(calls)[1]).toBe(
      'SELECT view_definition AS view_definition FROM information_schema.views WHERE table_schema = DATABASE() AND table_name = ?',
    )
    expect(calls[1].params).toEqual(['active_users'])
  })

  test('getIndexes groups statistics rows and drops PRIMARY', async () => {
    // information_schema.statistics is one row per indexed column, ordered by
    // seq_in_index; a composite index only comes out right if the rows are
    // accumulated rather than overwritten.
    const db = new MySQLAdapter()
    const calls = record(db, () => [
      { index_name: 'PRIMARY', non_unique: 0, table_name: 'app_users', column_name: 'id' },
      {
        index_name: 'idx_app_users_name',
        non_unique: 0,
        table_name: 'app_users',
        column_name: 'nick_name',
      },
      {
        index_name: 'idx_app_users_pair',
        non_unique: 1,
        table_name: 'app_users',
        column_name: 'first_name',
      },
      {
        index_name: 'idx_app_users_pair',
        non_unique: 1,
        table_name: 'app_users',
        column_name: 'last_name',
      },
    ])

    expect(await db.getIndexes()).toEqual({
      idxAppUsersName: { type: 'unique', table: 'appUsers', cols: ['nickName'] },
      idxAppUsersPair: {
        type: 'index',
        table: 'appUsers',
        cols: ['firstName', 'lastName'],
      },
    })
    expect(texts(calls)).toEqual([
      'SELECT index_name AS index_name, non_unique AS non_unique, table_name AS table_name, column_name AS column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND index_name IS NOT NULL ORDER BY index_name, seq_in_index',
    ])
  })

  test('getSchema reports row counts, pk flags and deduplicated indexes', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables')) return [{ name: 'app_users' }]
      if (sql.includes('COUNT(*)')) return [{ count: 3 }]
      if (sql.includes('information_schema.columns'))
        return [
          { name: 'id', type: 'int', is_nullable: 'NO', column_key: 'PRI' },
          { name: 'nick_name', type: 'varchar', is_nullable: 'YES', column_key: '' },
        ]
      if (sql.includes('information_schema.statistics'))
        return [
          { name: 'PRIMARY', non_unique: 0 },
          { name: 'idx_pair', non_unique: 1 },
          { name: 'idx_pair', non_unique: 1 },
        ]
      return []
    })

    expect(await db.getSchema()).toEqual([
      {
        name: 'app_users',
        rowCount: 3,
        columns: [
          { name: 'id', type: 'int', notnull: true, pk: true },
          { name: 'nick_name', type: 'varchar', notnull: false, pk: false },
        ],
        indexes: [
          { name: 'PRIMARY', unique: true },
          { name: 'idx_pair', unique: false },
        ],
      },
    ])
    // Every one of the four statements is asserted in full. A fixture keyed on
    // `sql.includes('information_schema.statistics')` keeps answering after the
    // *selected columns* are broken, so only the text catches that.
    expect(texts(calls)).toEqual([
      'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name',
      'SELECT COUNT(*) as count FROM `app_users`',
      'SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable, column_key AS column_key FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE() ORDER BY ordinal_position',
      'SELECT index_name AS name, non_unique AS non_unique FROM information_schema.statistics WHERE table_name = ? AND table_schema = DATABASE()',
    ])
  })

  test('getData validates sort and filter columns against the real column list', async () => {
    const db = new MySQLAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.columns')) return [{ name: 'nick_name' }]
      if (sql.includes('COUNT(*)')) return [{ count: 1 }]
      return []
    })
    await db.getData('app_users', {
      page: 2,
      pageSize: 10,
      sortBy: 'nick_name; DROP TABLE app_users',
      filters: { nick_name: 'an', not_a_column: 'x' },
    })
    expect(calls[0]).toEqual({
      sql: 'SELECT column_name AS name FROM information_schema.columns WHERE table_name = ? AND table_schema = DATABASE()',
      params: ['app_users'],
    })
    // The bogus sort column is dropped rather than interpolated, and only the
    // real filter column produces a bound LIKE.
    expect(calls[1].sql).toBe(
      'SELECT COUNT(*) as count FROM `app_users` WHERE `nick_name` LIKE ?',
    )
    expect(calls[2]).toEqual({
      sql: 'SELECT * FROM `app_users` WHERE `nick_name` LIKE ? LIMIT ? OFFSET ?',
      params: ['%an%', 10, 10],
    })
  })
})

describe('Postgres introspection queries', () => {
  test('hasCol binds both names and is normalised to $n', async () => {
    const db = new PGAdapter()
    const calls = record(db, () => [{ '?column?': 1 }])
    expect(await db.hasCol('app_users', 'nick_name')).toBe(true)
    expect(calls[0]).toEqual({
      sql: 'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = current_schema()',
      params: ['app_users', 'nick_name'],
    })
  })

  test('getConstraints resolves primary keys from a separate join', async () => {
    // Postgres exposes no per-column `column_key`, so the PK set has to be
    // assembled from table_constraints ⋈ key_column_usage before the columns
    // are walked.
    const db = new PGAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ table_name: 'app_users', table_type: 'BASE TABLE' }]
      if (sql.includes('table_constraints'))
        return [{ table_name: 'app_users', column_name: 'id' }]
      if (sql.includes('information_schema.columns'))
        return [
          {
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: "nextval('app_users_id_seq'::regclass)",
            udt_name: 'int4',
          },
          {
            column_name: 'is_active',
            data_type: 'boolean',
            is_nullable: 'YES',
            column_default: 'true',
            udt_name: 'bool',
          },
          {
            column_name: 'payload',
            data_type: 'bytea',
            is_nullable: 'YES',
            column_default: null,
            udt_name: 'bytea',
          },
        ]
      return []
    })

    const constraints = await db.getConstraints()
    expect(constraints.appUsers.id).toEqual({
      type: 'integer',
      primary: true,
      autoIncrement: true,
      default: "nextval('app_users_id_seq'::regclass)",
    })
    expect(constraints.appUsers.isActive).toEqual({
      type: 'boolean',
      nullable: true,
      default: 'true',
    })
    expect(constraints.appUsers.payload).toEqual({
      type: 'buffer',
      nullable: true,
      default: null,
    })
    expect(texts(calls)[0]).toBe(
      // Not aliased, unlike MySQL's: Postgres folds unquoted identifiers to
      // lowercase, so `table_name` comes back as written.
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = current_schema() AND table_type IN ('BASE TABLE','VIEW')",
    )
    expect(texts(calls)[1]).toBe(
      "SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.constraint_schema = current_schema()",
    )
    // is_identity/identity_generation are load-bearing, not incidental: an
    // identity column's sequence appears nowhere in column_default, so without
    // them a Bakery-created table reports its own primary key as ordinary.
    expect(texts(calls)[2]).toBe(
      'SELECT column_name, data_type, is_nullable, column_default, udt_name, is_identity, identity_generation FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position',
    )
  })

  test('type mapping covers the Postgres spellings the ORM emits', () => {
    const map = (dataType: string) => {
      const pg = new PGAdapter()
      const parse = (pg as unknown as {
        parseConstraints: (col: unknown, primary?: boolean) => { type: string }
      }).parseConstraints.bind(pg)
      return parse({ data_type: dataType, is_nullable: 'YES' }).type
    }
    expect(map('integer')).toBe('integer')
    // `bigint` is its own schema type now, and is matched *before* the generic
    // 'int' rule precisely so it does not collapse back into 'integer' — which
    // would rebuild every BIGINT column on every sync.
    expect(map('bigint')).toBe('bigint')
    expect(map('jsonb')).toBe('json')
    expect(map('smallint')).toBe('integer')
    expect(map('boolean')).toBe('boolean')
    expect(map('bytea')).toBe('buffer')
    expect(map('double precision')).toBe('number')
    expect(map('numeric')).toBe('number')
    expect(map('real')).toBe('number')
    expect(map('text')).toBe('string')
    expect(map('character varying')).toBe('string')
  })

  test('getIndexes skips the pkey, parses columns out of indexdef', async () => {
    const db = new PGAdapter()
    const calls = record(db, () => [
      {
        indexname: 'app_users_pkey',
        indexdef: 'CREATE UNIQUE INDEX app_users_pkey ON public.app_users USING btree (id)',
        tablename: 'app_users',
      },
      {
        indexname: 'idx_app_users_name',
        indexdef:
          'CREATE UNIQUE INDEX idx_app_users_name ON public.app_users USING btree (nick_name)',
        tablename: 'app_users',
      },
      {
        indexname: 'idx_app_users_pair',
        indexdef:
          'CREATE INDEX idx_app_users_pair ON public.app_users USING btree (first_name, last_name)',
        tablename: 'app_users',
      },
    ])

    expect(await db.getIndexes()).toEqual({
      idxAppUsersName: { type: 'unique', table: 'appUsers', cols: ['nickName'] },
      idxAppUsersPair: {
        type: 'index',
        table: 'appUsers',
        cols: ['firstName', 'lastName'],
      },
    })
    expect(texts(calls)).toEqual([
      'SELECT indexname, indexdef, tablename FROM pg_indexes WHERE schemaname = current_schema()',
    ])
  })

  test('getSchema casts the count to int and finds pks via regclass', async () => {
    // COUNT(*) is bigint in Postgres and arrives as a string without the cast,
    // which would make rowCount a string in every dashboard payload.
    const db = new PGAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ name: 'app_users', type: 'BASE TABLE' }]
      if (sql.includes('COUNT(*)')) return [{ count: 3 }]
      if (sql.includes('information_schema.columns'))
        return [
          { name: 'id', type: 'integer', is_nullable: 'NO' },
          { name: 'nick_name', type: 'text', is_nullable: 'YES' },
        ]
      if (sql.includes('pg_indexes'))
        return [
          {
            name: 'idx_name',
            def: 'CREATE UNIQUE INDEX idx_name ON public.app_users USING btree (nick_name)',
          },
        ]
      if (sql.includes('pg_index')) return [{ name: 'id' }]
      return []
    })

    expect(await db.getSchema()).toEqual([
      {
        name: 'app_users',
        rowCount: 3,
        columns: [
          { name: 'id', type: 'integer', notnull: true, pk: true },
          { name: 'nick_name', type: 'text', notnull: false, pk: false },
        ],
        indexes: [{ name: 'idx_name', unique: true }],
      },
    ])
    expect(texts(calls)).toEqual([
      "SELECT table_name AS name, table_type AS type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name",
      'SELECT COUNT(*)::int as count FROM "app_users"',
      "SELECT column_name AS name, data_type AS type, is_nullable AS is_nullable FROM information_schema.columns WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY ordinal_position",
      'SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indisprimary AND i.indrelid = "app_users"::regclass',
      "SELECT indexname AS name, indexdef AS def FROM pg_indexes WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename = $1",
    ])
  })

  test('getData selects ctid as the row handle', async () => {
    const db = new PGAdapter()
    const calls = record(db, sql => {
      if (sql.includes('information_schema.columns')) return [{ name: 'nick_name' }]
      if (sql.includes('COUNT(*)')) return [{ count: 1 }]
      return []
    })
    await db.getData('app_users', {
      page: 1,
      pageSize: 25,
      sortBy: 'nick_name',
      sortOrder: 'desc',
    })
    expect(calls[0]).toEqual({
      sql: "SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1 AND table_schema NOT IN ('pg_catalog', 'information_schema')",
      params: ['app_users'],
    })
    expect(calls[2]).toEqual({
      sql: 'SELECT ctid::text AS rowid, * FROM "app_users" ORDER BY "nick_name" DESC LIMIT $1 OFFSET $2',
      params: [25, 0],
    })
  })
})

/**
 * SQLite runs for real. Everything above asserts text; this asserts that the
 * text a database actually accepts comes back out of introspection the way the
 * sync engine expects.
 */
describe('SQLite: DDL round-trips through introspection', () => {
  const dbFile = path.join(
    tmpdir(),
    `bakery-ddl-${process.pid}-${Date.now()}.db`,
  )
  let db: SQLiteAdapter

  beforeAll(async () => {
    // A file, not :memory:, so the on-disk path — directory creation, the
    // startup PRAGMAs — is exercised alongside the DDL.
    db = new SQLiteAdapter(dbFile)
    await db.createTable('app_users', [
      `${db.quote('id')} ${db.colDef({ type: 'integer', primary: true, autoIncrement: true })}`,
      `${db.quote('nick_name')} ${db.colDef({ type: 'string' })}`,
      `${db.quote('created_at')} ${db.colDef({ type: 'integer', default: '%dateNow%' })}`,
      `${db.quote('score')} ${db.colDef({ type: 'number', nullable: true, default: 1.5 })}`,
      `${db.quote('is_active')} ${db.colDef({ type: 'boolean', default: true })}`,
      `${db.quote('payload')} ${db.colDef({ type: 'buffer', nullable: true })}`,
      `${db.quote('email')} TEXT UNIQUE`,
    ])
    await db.createIndex('idx_app_users_name', 'app_users', ['nick_name'], true)
    await db.createIndex('idx_app_users_pair', 'app_users', [
      'nick_name',
      'score',
    ])
    await db.createView(
      'active_users',
      `SELECT ${db.quote('id')} FROM ${db.quote('app_users')}`,
    )
    await db.insert('app_users', [{ nickName: 'ann' }, { nickName: 'bob' }])
  })

  afterAll(async () => {
    await db.close()
    // WAL/journal siblings only exist on some platforms; `force` makes a
    // missing file a no-op rather than an error.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${dbFile}${suffix}`, { force: true })
    }
  })

  test('every colDef survives the round trip back to a constraint', async () => {
    const constraints = await db.getConstraints()
    expect(constraints.appUsers).toEqual({
      id: { type: 'integer', primary: true, autoIncrement: true, default: null },
      nickName: { type: 'string', default: null },
      createdAt: { type: 'integer', default: '%dateNow%' },
      score: { type: 'number', nullable: true, default: 1.5 },
      // Declared `boolean`; SQLite has no boolean type, so it comes back as the
      // INTEGER it is really stored as. The sync diff special-cases exactly
      // this pair (sync/helpers.ts diffColumnMismatch), so it is not drift.
      isActive: { type: 'integer', default: 1 },
      payload: { type: 'buffer', nullable: true, default: null },
      email: { type: 'string', nullable: true, default: null },
    })
  })

  test('the %dateNow% default is written and recognised again', async () => {
    // The stored text is dialect-specific; `%dateNow%` is the schema-level
    // token, and the trip out and back has to preserve it or every sync
    // rebuilds the table.
    const stored = (await db
      .query("SELECT sql FROM sqlite_master WHERE name = 'app_users'")
      .get()) as { sql: string }
    expect(stored.sql).toContain("DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))")
    expect((await db.getConstraints()).appUsers.createdAt.default).toBe('%dateNow%')
  })

  test('a view reports its body and its columns, but no defaults', async () => {
    const constraints = await db.getConstraints()
    // Quotes are stripped from plain identifiers so the stored body can be
    // compared against the one in schema.ts.
    expect(constraints.activeUsers._view).toBe('SELECT id FROM app_users')
    expect(constraints.activeUsers.id).toEqual({ type: 'integer', nullable: true })
  })

  test('getIndexes reports declared indexes with their columns in order', async () => {
    expect(await db.getIndexes()).toEqual({
      idxAppUsersName: { type: 'unique', table: 'appUsers', cols: ['nickName'] },
      idxAppUsersPair: {
        type: 'index',
        table: 'appUsers',
        cols: ['nickName', 'score'],
      },
    })
  })

  test('getIndexes excludes the implicit index behind a UNIQUE column', async () => {
    // `email TEXT UNIQUE` creates sqlite_autoindex_app_users_1. It has no SQL
    // of its own, so reporting it would make the sync engine try to drop an
    // index that cannot be dropped.
    const names = Object.keys(await db.getIndexes())
    expect(names.some(n => n.toLowerCase().includes('autoindex'))).toBe(false)
    // getSchema does show it — that view is the dashboard's, not the planner's.
    const schema = await db.getSchema()
    const users = schema.find(t => t.name === 'app_users')
    expect(users?.indexes.map(i => i.name)).toContain(
      'sqlite_autoindex_app_users_1',
    )
  })

  test('getSchema reports counts, nullability, pk and uniqueness', async () => {
    const users = (await db.getSchema()).find(t => t.name === 'app_users')
    expect(users?.rowCount).toBe(2)
    expect(users?.columns).toEqual([
      { name: 'id', type: 'INTEGER', notnull: false, pk: true },
      { name: 'nick_name', type: 'TEXT', notnull: true, pk: false },
      { name: 'created_at', type: 'INTEGER', notnull: true, pk: false },
      { name: 'score', type: 'REAL', notnull: false, pk: false },
      { name: 'is_active', type: 'INTEGER', notnull: true, pk: false },
      { name: 'payload', type: 'BLOB', notnull: false, pk: false },
      { name: 'email', type: 'TEXT', notnull: false, pk: false },
    ])
    expect(
      users?.indexes.find(i => i.name === 'idx_app_users_name')?.unique,
    ).toBe(true)
    expect(
      users?.indexes.find(i => i.name === 'idx_app_users_pair')?.unique,
    ).toBe(false)
  })

  test('AUTOINCREMENT creates sqlite_sequence, and it stays out of the schema', async () => {
    // It really is there — if it leaked into getSchema/getConstraints the sync
    // engine would plan to drop a table SQLite owns.
    const master = (await db
      .query("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'")
      .all()) as Array<{ name: string }>
    expect(master.length).toBe(1)
    expect((await db.getSchema()).map(t => t.name)).not.toContain('sqlite_sequence')
    expect(Object.keys(await db.getConstraints())).not.toContain('sqliteSequence')
  })

  test('hasCol answers from the live table', async () => {
    expect(await db.hasCol('app_users', 'nick_name')).toBe(true)
    expect(await db.hasCol('app_users', 'no_such_column')).toBe(false)
  })

  /**
   * `hasCol` built `PRAGMA table_info('${table}')` by interpolation — a second
   * SQL identifier writer on a public adapter method, outside the `qId`/`qRef`/
   * `safeColumn` guards convention 8 makes the only ones. MySQL and Postgres
   * already bound theirs; SQLite now uses the `pragma_table_info` table-valued
   * function so the name binds too.
   */
  test('hasCol binds the table name instead of interpolating it', async () => {
    const [rec, calls] = sqliteRecorder(() => [])
    await rec.hasCol('app_users', 'nick_name')
    expect(calls[0]).toEqual({
      sql: 'SELECT name FROM pragma_table_info(?)',
      params: ['app_users'],
    })
    expect(calls[0].sql).not.toContain('app_users')
  })

  test('a table name carrying a quote no longer breaks the statement', async () => {
    // Reached only from the sync engine today, with schema-derived names — but
    // it is a public method, so the argument is treated as untrusted. Under the
    // interpolated form this closed the string literal and SQLite answered
    // `near "ird": syntax error`.
    const odd = new SQLiteAdapter(':memory:')
    recorded.push(odd)
    await odd.query(`CREATE TABLE ${odd.quote("we'ird")} (a INTEGER)`).run()
    expect(await odd.hasCol("we'ird", 'a')).toBe(true)
    expect(await odd.hasCol("we'ird", 'b')).toBe(false)
  })

  test('getData filters and sorts only by columns that exist', async () => {
    const filtered = await db.getData('app_users', {
      page: 1,
      pageSize: 10,
      sortBy: 'nick_name',
      sortOrder: 'DESC',
      filters: { nick_name: 'an' },
    })
    expect(filtered.totalRows).toBe(1)
    expect(filtered.rows[0].nick_name).toBe('ann')

    const injected = await db.getData('app_users', {
      page: 1,
      pageSize: 10,
      sortBy: 'nick_name; DROP TABLE app_users',
      filters: { not_a_column: 'x' },
    })
    expect(injected.totalRows).toBe(2)
    // The table is still there, which is the point.
    expect((await db.getSchema()).map(t => t.name)).toContain('app_users')
  })
})

describe('SQLite: mutating DDL applied and read back', () => {
  const open: SQLiteAdapter[] = []

  afterAll(async () => {
    for (const db of open) await db.close()
  })

  async function fresh(): Promise<SQLiteAdapter> {
    const db = new SQLiteAdapter(':memory:')
    open.push(db)
    await db.createTable('app_users', [
      `${db.quote('id')} ${db.colDef({ type: 'integer', primary: true, autoIncrement: true })}`,
      `${db.quote('nick_name')} ${db.colDef({ type: 'string' })}`,
    ])
    return db
  }

  test('addCol appears in hasCol, getConstraints and getSchema', async () => {
    const db = await fresh()
    await db.addCol('app_users', 'tag_line', {
      type: 'string',
      nullable: true,
      default: 'none',
    })
    expect(await db.hasCol('app_users', 'tag_line')).toBe(true)
    expect((await db.getConstraints()).appUsers.tagLine).toEqual({
      type: 'string',
      nullable: true,
      default: 'none',
    })
    const users = (await db.getSchema()).find(t => t.name === 'app_users')
    expect(users?.columns.map(c => c.name)).toContain('tag_line')
  })

  test('a renamed column keeps its constraint under the new name', async () => {
    const db = await fresh()
    await db.rename('COLUMN', 'app_users', 'nick_name', 'display_name')
    const cols = Object.keys((await db.getConstraints()).appUsers)
    expect(cols).toContain('displayName')
    expect(cols).not.toContain('nickName')
  })

  test('a renamed table keeps its columns and its indexes', async () => {
    const db = await fresh()
    await db.createIndex('idx_nick', 'app_users', ['nick_name'])
    await db.rename('TABLE', 'app_users', 'people')
    expect((await db.getSchema()).map(t => t.name)).toEqual(['people'])
    // SQLite rewrites the index's tbl_name for us; introspection must follow.
    expect((await db.getIndexes()).idxNick.table).toBe('people')
  })

  test('drop COLUMN and drop INDEX are visible immediately', async () => {
    const db = await fresh()
    await db.addCol('app_users', 'tag_line', { type: 'string', nullable: true })
    await db.createIndex('idx_nick', 'app_users', ['nick_name'])
    await db.drop('COLUMN', 'app_users', 'tag_line')
    await db.drop('INDEX', 'idx_nick')
    expect(await db.hasCol('app_users', 'tag_line')).toBe(false)
    expect(await db.getIndexes()).toEqual({})
  })

  test('truncate empties the table but keeps it', async () => {
    const db = await fresh()
    await db.insert('app_users', [{ nickName: 'ann' }, { nickName: 'bob' }])
    await db.truncate('app_users')
    const users = (await db.getSchema()).find(t => t.name === 'app_users')
    expect(users?.rowCount).toBe(0)
    expect(users).toBeDefined()
  })

  test('drop TABLE removes it from both introspection surfaces', async () => {
    const db = await fresh()
    await db.drop('TABLE', 'app_users')
    expect(await db.getSchema()).toEqual([])
    expect(await db.getConstraints()).toEqual({})
  })

  test('copyTableData moves the named columns between tables', async () => {
    const db = await fresh()
    await db.insert('app_users', [{ nickName: 'ann' }, { nickName: 'bob' }])
    await db.createTable('app_users_new', [
      `${db.quote('nick_name')} ${db.colDef({ type: 'string' })}`,
    ])
    await db.copyTableData('app_users', 'app_users_new', ['nick_name'])
    const copied = (await db.getSchema()).find(t => t.name === 'app_users_new')
    expect(copied?.rowCount).toBe(2)
  })

  test('a quote-bearing string default is written as valid DDL', async () => {
    // formatDefault doubles the apostrophe; if it did not, CREATE TABLE would
    // fail here rather than in production.
    const db = new SQLiteAdapter(':memory:')
    open.push(db)
    await db.createTable('mottos', [
      `${db.quote('motto')} ${db.colDef({ type: 'string', nullable: true, default: "it's fine" })}`,
    ])
    await db.query('INSERT INTO "mottos" DEFAULT VALUES').run()
    const row = (await db.query('SELECT "motto" FROM "mottos"').get()) as {
      motto: string
    }
    expect(row.motto).toBe("it's fine")
  })
})

/**
 * Defects, pinned so they are visible.
 *
 * Each of these asserts behaviour that is wrong. They are here because the
 * alternative — a comment nobody greps for — is how they survived this long.
 * Fixing one is expected to break its test; the comment says what the fix is.
 */
describe('dialect defects, fixed and pinned', () => {
  test('%dateNow% emits a complete, balanced expression on every dialect', () => {
    // `dateNowDefaults` was doing two jobs. isDateNowDefault() matches an
    // introspected default with `includes`, so a prefix works there;
    // formatDefault() *emitted* dateNowDefaults[0], where a prefix is fatal.
    // Postgres got `DEFAULT (EXTRACT(EPOCH FROM)` — unbalanced, a syntax
    // error — and `createdAt: value('integer', dateNow)` ships in
    // schema.example.ts, so it fired on the first db:sync against Postgres.
    // The emitted text is now `dateNowExpression`, separate from the patterns.
    const lite = new SQLiteAdapter(':memory:')
    recorded.push(lite)
    const liteDef = lite.colDef({ type: 'integer', default: '%dateNow%' })
    const pgDef = new PGAdapter().colDef({ type: 'integer', default: '%dateNow%' })
    const myDef = new MySQLAdapter().colDef({
      type: 'integer',
      default: '%dateNow%',
    })

    expect(liteDef).toBe(
      "INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))",
    )
    expect(pgDef).toBe('INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()))')
    expect(myDef).toBe('INT NOT NULL DEFAULT (UNIX_TIMESTAMP())')

    for (const def of [liteDef, pgDef, myDef]) {
      expect(parensBalanced(def)).toBe(true)
    }
  })

  test('an emitted %dateNow% is still recognised when read back', () => {
    // The emit and match halves have to agree or the column diffs dirty on
    // every sync forever. Postgres stores a parsed expression rather than DDL
    // text and re-renders it, so the read-back is never what we emitted: PG
    // 14+ gives `(EXTRACT(epoch FROM now()))::integer`, and PG <= 13 parses
    // EXTRACT into date_part.
    const pg = new PGAdapter()
    expect(pg.isDateNowDefault('EXTRACT(EPOCH FROM NOW())')).toBe(true)
    expect(pg.isDateNowDefault('(EXTRACT(epoch FROM now()))::integer')).toBe(
      true,
    )
    expect(pg.isDateNowDefault("date_part('epoch'::text, now())")).toBe(true)
    expect(pg.isDateNowDefault('42')).toBe(false)

    const my = new MySQLAdapter()
    expect(my.isDateNowDefault('unix_timestamp()')).toBe(true)
    expect(my.isDateNowDefault('UNIX_TIMESTAMP')).toBe(true)
    expect(my.isDateNowDefault('42')).toBe(false)
  })

  test('an adapter without a dateNowExpression fails loudly', () => {
    // Rather than emitting `DEFAULT ()` or silently dropping the default,
    // which would surface much later as a NOT NULL violation at insert time.
    class Incomplete extends SQLiteAdapter {
      override readonly dateNowExpression: string = ''
    }
    const db = new Incomplete(':memory:')
    recorded.push(db)
    expect(() => db.colDef({ type: 'integer', default: '%dateNow%' })).toThrow(
      /dateNowExpression/,
    )
  })

  test('MySQL reports a tinyint(1) as boolean, and a wider tinyint as integer', async () => {
    // mysqlTypes tests for 'tinyint(1)', but parseConstraints fed it
    // `data_type` first — and data_type is 'tinyint', without the display
    // width. column_type is the one carrying 'tinyint(1)', so the boolean
    // branch was unreachable through getConstraints and SchemaBuilder emitted
    // value('integer') for every boolean.
    const db = new MySQLAdapter()
    record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ table_name: 'app_users', table_type: 'BASE TABLE' }]
      if (sql.includes('information_schema.columns'))
        return [
          {
            column_name: 'is_active',
            column_type: 'tinyint(1)',
            data_type: 'tinyint',
            is_nullable: 'YES',
            column_key: '',
            column_default: '1',
            extra: '',
          },
          {
            // Same data_type, different display width: must stay integer, or
            // the fix would just move the wrong answer to the other column.
            column_name: 'retry_count',
            column_type: 'tinyint(4)',
            data_type: 'tinyint',
            is_nullable: 'YES',
            column_key: '',
            column_default: '0',
            extra: '',
          },
        ]
      return []
    })
    const constraints = await db.getConstraints()
    expect(constraints.appUsers.isActive.type).toBe('boolean')
    expect(constraints.appUsers.retryCount.type).toBe('integer')
  })

  test('Postgres detects both identity and legacy serial columns', async () => {
    // colDef emits `INTEGER GENERATED BY DEFAULT AS IDENTITY`. An identity
    // column has column_default NULL — the sequence shows up in is_identity,
    // which the columns query did not select. parseConstraints looked only for
    // 'nextval' in column_default, so a Bakery-created Postgres table reported
    // its own primary key as not auto-incrementing. Both styles now resolve:
    // identity via is_identity, pre-existing serial columns via nextval.
    const db = new PGAdapter()
    record(db, sql => {
      if (sql.includes('information_schema.tables'))
        return [{ table_name: 'app_users', table_type: 'BASE TABLE' }]
      if (sql.includes('table_constraints'))
        return [{ table_name: 'app_users', column_name: 'id' }]
      if (sql.includes('information_schema.columns'))
        return [
          {
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            is_identity: 'YES',
            identity_generation: 'BY DEFAULT',
            udt_name: 'int4',
          },
          {
            // A table Bakery did not create: the older serial style, where
            // the sequence shows up in column_default instead.
            column_name: 'legacy_id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: "nextval('app_users_legacy_id_seq'::regclass)",
            is_identity: 'NO',
            udt_name: 'int4',
          },
          {
            column_name: 'label',
            data_type: 'text',
            is_nullable: 'YES',
            column_default: null,
            is_identity: 'NO',
            udt_name: 'text',
          },
        ]
      return []
    })
    const constraints = await db.getConstraints()
    expect(constraints.appUsers.id.primary).toBe(true)
    expect(constraints.appUsers.id.autoIncrement).toBe(true)
    expect(constraints.appUsers.legacyId.autoIncrement).toBe(true)
    expect(constraints.appUsers.label.autoIncrement).toBeUndefined()
  })

  test('a SQLite string default survives the round trip unchanged', async () => {
    // formatDefault writes `DEFAULT 'it''s fine'`; parseDefault stripped the
    // outer quotes with slice(1, -1) but never collapsed '' back to '. The
    // schema said "it's fine", the database reported "it''s fine", and
    // diffColumnMismatch marked the column changed — so every db:sync rebuilt
    // the table, forever, for any default containing an apostrophe.
    const db = new SQLiteAdapter(':memory:')
    recorded.push(db)
    await db.createTable('mottos', [
      `${db.quote('motto')} ${db.colDef({ type: 'string', nullable: true, default: "it's fine" })}`,
    ])
    // The value the schema declared, not the escaped form SQLite stores.
    expect((await db.getConstraints()).mottos.motto.default).toBe("it's fine")
  })

  test('SQLite emits AUTOINCREMENT only on an integer key', async () => {
    // MySQL and Postgres both guard with `d.type === 'integer'`; SQLite did
    // not, and SQLite is the one dialect that refuses the result outright.
    const db = new SQLiteAdapter(':memory:')
    recorded.push(db)

    const textKey = db.colDef({
      type: 'string',
      primary: true,
      autoIncrement: true,
    })
    expect(textKey).toBe('TEXT PRIMARY KEY')
    // The point of the guard: SQLite now accepts this instead of rejecting it.
    await db.createTable('good_table', [`${db.quote('id')} ${textKey}`])

    // An integer key must keep it, or the guard has broken the normal case.
    expect(db.colDef({ type: 'integer', primary: true, autoIncrement: true })).toBe(
      'INTEGER PRIMARY KEY AUTOINCREMENT',
    )
  })
})
