import { afterAll, describe, expect, test } from 'bun:test'
import { PGAdapter } from './pgsql'
import { SQLiteAdapter } from './sqlite'
import { MySQLAdapter } from './mysql'
import { quoteIdentifier } from './base'

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
    expect(normalize("SELECT * FROM `t` WHERE s = 'what?' AND a = ?", [1])).toBe(
      'SELECT * FROM "t" WHERE s = \'what?\' AND a = $1',
    )
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
    const out = normalize("SELECT * FROM `t` WHERE s = 'it\\'s ?' AND a = ?", [1])
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
  afterAll(() => cleanup.forEach(fn => fn()))

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
      await db.query(`INSERT INTO ${db.quote(table)} (name) VALUES (?)`).run('first')

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
      await db.query(`INSERT INTO ${db.quote(table)} (name) VALUES (?)`).run('first')

      const rows = await db
        .query(`SELECT ${db.quote('name')} FROM ${db.quote(table)}`)
        .all()

      expect(rows).toHaveLength(1)
      expect((rows[0] as any).name).toBe('first')
    },
  )
})
