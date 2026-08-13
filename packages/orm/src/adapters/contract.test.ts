import { afterAll, describe, expect, test } from 'bun:test'
import { quoteIdentifier } from './base'
import { MySQLAdapter } from './mysql'
import { PGAdapter } from './pgsql'
import { SQLiteAdapter } from './sqlite'

/**
 * The contract every adapter owes the ORM.
 *
 * Only SQLite was ever genuinely exercised; MySQL and Postgres were trusted on
 * faith while their identifier quoting, placeholder syntax and DDL were edited
 * repeatedly. Most of that risk is in *what SQL is generated*, which needs no
 * server — so those parts are asserted unconditionally here, and the parts that
 * genuinely need a database are gated on a connection string being present.
 *
 * Set MYSQL_TEST_URL / PGSQL_TEST_URL to run the live half. Without them the
 * live tests report as skipped rather than passing silently, so an empty CI run
 * cannot be mistaken for a green one.
 */

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

describe('identifier quoting is per-dialect', () => {
  test('SQLite and Postgres use double quotes, MySQL uses backticks', () => {
    expect(new SQLiteAdapter(':memory:').quoteChar).toBe('"')
    // Constructed without connecting — quoteChar is a static property of the
    // dialect, not of a session.
    expect(new PGAdapter().quoteChar).toBe('"')
    expect(new MySQLAdapter().quoteChar).toBe('`')
  })

  test('quoting strips an embedded quote char so it cannot break out', () => {
    expect(quoteIdentifier('my"col', '"')).toBe('"mycol"')
    expect(quoteIdentifier('my`col', '`')).toBe('`mycol`')
    // A quote of the *other* dialect is not special and must survive intact.
    expect(quoteIdentifier('my`col', '"')).toBe('"my`col"')
  })

  test('each adapter quotes through its own dialect', () => {
    expect(new SQLiteAdapter(':memory:').quote('users')).toBe('"users"')
    expect(new PGAdapter().quote('users')).toBe('"users"')
    expect(new MySQLAdapter().quote('users')).toBe('`users`')
  })
})

/**
 * The ORM emits MySQL-flavoured SQL (backticks, `?` placeholders) and each
 * adapter translates. Postgres has the most to do, and does it with a
 * quote-aware scanner — which is exactly where an off-by-one or a naive
 * replace would corrupt a query.
 */
describe('Postgres normalisation', () => {
  const normalize = (sql: string, params: unknown[] = []) =>
    (PGAdapter as any).normalizePostgresSQL(sql, params)

  test('rewrites ? placeholders to positional $n', () => {
    expect(normalize('SELECT * FROM `t` WHERE a = ? AND b = ?', [1, 2])).toBe(
      'SELECT * FROM "t" WHERE a = $1 AND b = $2',
    )
  })

  test('numbers placeholders from one, in order', () => {
    expect(normalize('INSERT INTO `t` VALUES (?, ?, ?)', [1, 2, 3])).toBe(
      'INSERT INTO "t" VALUES ($1, $2, $3)',
    )
  })

  test('converts backtick identifiers to double quotes', () => {
    expect(normalize('SELECT `a`.`b` FROM `t`')).toBe('SELECT "a"."b" FROM "t"')
  })

  test('a doubled quote does not swallow the character after it', () => {
    // The scanner consumed its `skipNext` flag twice — once at the top of the
    // loop and again via `i++` — so an escaped quote ate the *next* character
    // too. `'a''b'` came out as `'a'''`, which Postgres reads as `a'`.
    //
    // It reached a live server as a corrupted column DEFAULT: a schema saying
    // `value('string', "it's fine")` created a column whose default was
    // `it' fine`, and every row silently got the truncated value. Nothing
    // caught it because these assertions run *before* normalisation and the
    // MySQL/Postgres suites had never been run against a real database.
    expect(normalize("SELECT 'a''b'")).toBe("SELECT 'a''b'")
    expect(normalize("SELECT 'it''s fine'")).toBe("SELECT 'it''s fine'")
    // …and the escape must not leak the scanner out of the literal: a `?`
    // after it is still data, not a placeholder.
    expect(normalize("SELECT 'a''b?' , ?", [1])).toBe("SELECT 'a''b?' , $1")
  })

  test('a backslash escape keeps the character it escapes', () => {
    // Same double-consume, via handleSpecial.
    expect(normalize("SELECT 'a\\'b'")).toBe("SELECT 'a\\'b'")
  })

  test('leaves a ? inside a string literal alone', () => {
    // The whole reason for a scanner rather than a regex: a question mark in
    // user data must not become a parameter reference.
    expect(
      normalize("SELECT * FROM `t` WHERE s = 'what?' AND a = ?", [1]),
    ).toBe('SELECT * FROM "t" WHERE s = \'what?\' AND a = $1')
  })

  test('leaves a backtick inside a string literal alone', () => {
    expect(normalize("SELECT * FROM `t` WHERE s = 'a`b'")).toBe(
      'SELECT * FROM "t" WHERE s = \'a`b\'',
    )
  })

  test('does not renumber when there are no parameters', () => {
    expect(normalize("SELECT * FROM `t` WHERE s = 'a?b'", [])).toBe(
      'SELECT * FROM "t" WHERE s = \'a?b\'',
    )
  })

  test('handles an escaped quote without losing track of the literal', () => {
    const out = normalize(
      "SELECT * FROM `t` WHERE s = 'it\\'s ?' AND a = ?",
      [1],
    )
    // The ? inside the literal stays literal; only the one outside binds.
    expect(out).toContain('$1')
    expect(out.match(/\$\d/g)).toHaveLength(1)
  })
})

/**
 * Executable round-trip. SQLite runs everywhere; the others need a server.
 */
describe('executable round-trip', () => {
  const cleanup: Array<() => void> = []
  afterAll(() => {
    for (const fn of cleanup) fn()
  })

  test('SQLite: generated SQL executes and returns rows', async () => {
    const db = new SQLiteAdapter(':memory:')
    cleanup.push(() => db.close?.())

    await db
      .query('CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)')
      .run()
    await db.query('INSERT INTO widgets (name) VALUES (?)').run('first')

    const rows = await db
      .query(`SELECT ${db.quote('name')} FROM ${db.quote('widgets')}`)
      .all()

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).name).toBe('first')
  })

  test.skipIf(!MYSQL_URL)(
    'MySQL: generated SQL executes and returns rows',
    async () => {
      const db = new MySQLAdapter(MYSQL_URL)
      const table = `bakery_contract_${Date.now()}`
      cleanup.push(() => void db.query(`DROP TABLE IF EXISTS ${table}`).run())

      await db
        .query(
          `CREATE TABLE ${db.quote(table)} (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64))`,
        )
        .run()
      await db
        .query(`INSERT INTO ${db.quote(table)} (name) VALUES (?)`)
        .run('first')

      const rows = await db
        .query(`SELECT ${db.quote('name')} FROM ${db.quote(table)}`)
        .all()

      expect(rows).toHaveLength(1)
      expect((rows[0] as any).name).toBe('first')
    },
  )

  test.skipIf(!PGSQL_URL)(
    'Postgres: ?-placeholders survive normalisation and execute',
    async () => {
      const db = new PGAdapter(PGSQL_URL)
      const table = `bakery_contract_${Date.now()}`
      cleanup.push(() => void db.query(`DROP TABLE IF EXISTS ${table}`).run())

      await db
        .query(
          `CREATE TABLE ${db.quote(table)} (id SERIAL PRIMARY KEY, name TEXT)`,
        )
        .run()
      // Written with ? on purpose: this is the ORM's dialect, and the adapter
      // is responsible for turning it into $1 before it reaches the server.
      await db
        .query(`INSERT INTO ${db.quote(table)} (name) VALUES (?)`)
        .run('first')

      const rows = await db
        .query(`SELECT ${db.quote('name')} FROM ${db.quote(table)}`)
        .all()

      expect(rows).toHaveLength(1)
      expect((rows[0] as any).name).toBe('first')
    },
  )
})

/**
 * `RunResult.changes` means the same thing on every dialect.
 *
 * It did not. Two different bugs, one symptom, and both survived because the
 * only adapter with a real local database was the one that happened to be
 * right:
 *
 * - **MySQL** put the count in `affectedRows` and left `count` at 0, and the
 *   `??` chain read `count` first — zero is not nullish, so it never fell
 *   through. Every write reported 0.
 * - **Postgres** guarded `count` behind `!Array.isArray(rows)`, which is never
 *   true (a write returns an empty array), so `changes` was `rows.length`.
 *   `UPDATE` and `DELETE` reported 0; `INSERT` was right only because the
 *   adapter appends `RETURNING *`.
 *
 * Asserted as a table rather than per-dialect, so a dialect that starts
 * disagreeing has to disagree visibly.
 */
describe('changes counts rows on every dialect', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
  })

  /** See adapters/nested-tx.test.ts — Bun's MySQL driver needs a pending timer. */
  function alive<T>(p: T | Promise<T>): Promise<T> {
    const t = setTimeout(() => {}, 30_000)
    return Promise.resolve(p).finally(() => clearTimeout(t))
  }

  const DIALECTS: [string, boolean, () => any][] = [
    ['SQLite', false, () => new SQLiteAdapter(':memory:')],
    ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL)],
    ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL)],
  ]

  for (const [name, skip, open] of DIALECTS) {
    test.skipIf(skip)(
      `${name}: insert, update and delete all count`,
      async () => {
        const db = open()
        const t = `bakery_chg_${process.pid}`
        const run = (s: string, ...p: unknown[]) => alive(db.query(s).run(...p))
        cleanup.push(async () => {
          await run(`DROP TABLE IF EXISTS ${t}`)
          await db.close?.()
        })

        await run(`DROP TABLE IF EXISTS ${t}`)
        await run(
          `CREATE TABLE ${t} (${db.quote('id')} INT NOT NULL,` +
            ` ${db.quote('n')} VARCHAR(16))`,
        )

        const one = await run(`INSERT INTO ${t} VALUES (?, ?)`, 1, 'a')
        const three = await run(
          `INSERT INTO ${t} VALUES (?, ?), (?, ?), (?, ?)`,
          2,
          'b',
          3,
          'c',
          4,
          'd',
        )
        const updated = await run(
          `UPDATE ${t} SET ${db.quote('n')} = ? WHERE ${db.quote('id')} > ?`,
          'z',
          1,
        )
        const deleted = await run(
          `DELETE FROM ${t} WHERE ${db.quote('id')} > ?`,
          2,
        )

        expect({
          dialect: name,
          insert1: one.changes,
          insert3: three.changes,
          update3: updated.changes,
          delete2: deleted.changes,
        }).toEqual({
          dialect: name,
          insert1: 1,
          insert3: 3,
          update3: 3,
          delete2: 2,
        })
      },
    )
  }

  /**
   * `getSchema()` must name **every** column of a composite primary key.
   *
   * SQLite reported only the first. `PRAGMA table_info` gives `pk` as the
   * column's 1-based position in the key, not a boolean, and the adapter tested
   * `c.pk === 1` — so `PRIMARY KEY (tenant_id, code)` came back as a
   * single-column key on `tenant_id`. MySQL and Postgres were always right,
   * which is exactly why this needs to run on all three: the bug is invisible
   * unless you compare them.
   *
   * It matters beyond tidiness. Anything that derives a row's identity from
   * `getSchema()` — a grid editor addressing a row for UPDATE, say — would
   * build `WHERE tenant_id = ?` and hit every row in the tenant.
   */
  for (const [name, skip, open] of DIALECTS) {
    test.skipIf(skip)(
      `${name}: getSchema names every composite PK column`,
      async () => {
        const db = open()
        const t = `bakery_cpk_${process.pid}`
        const run = (s: string, ...p: unknown[]) => alive(db.query(s).run(...p))
        cleanup.push(async () => {
          await run(`DROP TABLE IF EXISTS ${t}`)
          await db.close?.()
        })

        await run(`DROP TABLE IF EXISTS ${t}`)
        await run(
          `CREATE TABLE ${t} (${db.quote('tenant_id')} INT NOT NULL,` +
            ` ${db.quote('code')} VARCHAR(16) NOT NULL,` +
            ` ${db.quote('label')} VARCHAR(32),` +
            ` PRIMARY KEY (${db.quote('tenant_id')}, ${db.quote('code')}))`,
        )

        const schema = await alive(db.getSchema())
        const table = schema.find((s: any) => s.name === t)
        const pkCols = table?.columns
          .filter((c: any) => c.pk)
          .map((c: any) => c.name)
          .sort()

        expect({ dialect: name, pkCols }).toEqual({
          dialect: name,
          pkCols: ['code', 'tenant_id'],
        })
      },
    )
  }
})
