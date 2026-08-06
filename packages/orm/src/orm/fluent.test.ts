import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

/**
 * The builder's interfaces modelled a stricter grammar than either the runtime
 * or ordinary SQL: `IQBTable` exposed no orderBy/limit, and `IQBSelect` no
 * where. Both call orders always worked — the clauses are assembled and only
 * emitted at parse() — so the types, not the behaviour, were wrong.
 *
 * These assertions are as much about compilation as execution: the file is
 * typechecked, so a regression in the interface chain fails the build even if
 * the generated SQL is still correct.
 */
let db: SQLiteAdapter

beforeAll(() => {
  db = new SQLiteAdapter(':memory:')
  __setTestDb(db)
})

afterAll(() => __resetTestDb())

describe('ordering and paging straight off a table', () => {
  test('orderBy needs no preceding where or select', () => {
    const { sql } = DB.table('users').orderBy('id', 'DESC').parse()
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('DESC')
  })

  test('limit needs no preceding where or select', () => {
    const { sql } = DB.table('users').limit(10).parse()
    expect(sql).toContain('LIMIT 10')
  })

  test('paginate needs no preceding where or select', () => {
    const { sql } = DB.table('users').paginate(3, 20).parse()
    expect(sql).toContain('LIMIT 20')
    expect(sql).toContain('OFFSET 40')
  })

  test('ordering then paging composes', () => {
    const { sql } = DB.table('users').orderBy('id').limit(5).parse()
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('LIMIT 5')
  })
})

describe('filtering after projection', () => {
  test('where is legal after select', () => {
    const { sql, params } = DB.table('users')
      .select({ ident: 'users.id' })
      .where('users.id', 5)
      .parse()

    expect(sql).toContain('WHERE')
    expect(sql).toContain('AS "ident"')
    expect(params).toEqual([5])
  })

  test('and/or chain after select', () => {
    const { sql, params } = DB.table('users')
      .selectAll('users')
      .where('users.id', 1)
      .and('users.username', 'ada')
      .parse()

    expect(sql).toContain('WHERE')
    expect(sql).toContain('AND')
    expect(params).toEqual([1, 'ada'])
  })

  test('clause order does not change the emitted SQL', () => {
    // The builder assembles clauses; only parse() emits. Both spellings must
    // produce the same statement.
    const selectFirst = DB.table('users')
      .select({ ident: 'users.id' })
      .where('users.id', 7)
      .parse()

    const whereFirst = DB.table('users')
      .where('users.id', 7)
      .select({ ident: 'users.id' })
      .parse()

    expect(selectFirst.sql).toBe(whereFirst.sql)
    expect(selectFirst.params).toEqual(whereFirst.params)
  })
})

describe('the newly-typed orders actually execute', () => {
  test('select-then-where round-trips against a real database', async () => {
    await db
      .query('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)')
      .run()
    await db.query('INSERT INTO users (username) VALUES (?)').run('ada')
    await db.query('INSERT INTO users (username) VALUES (?)').run('grace')

    const rows = await DB.table('users')
      .selectAll('users')
      .where('users.username', 'grace')
      .array()

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).username).toBe('grace')
  })

  test('table-then-orderBy-then-limit round-trips', async () => {
    const rows = await DB.table('users').orderBy('id', 'DESC').limit(1).array()

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).username).toBe('grace')
  })
})
