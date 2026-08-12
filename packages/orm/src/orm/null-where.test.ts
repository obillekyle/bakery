import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

/**
 * `where(col, null)` used to compile to a bound NULL — `col = ?` with a null
 * parameter — which SQL's three-valued logic makes UNKNOWN for every row. The
 * query is valid, runs, and matches nothing, so a migration walking rows
 * `where('legacy_id', null)` reported "0 nulls" over a column full of them.
 *
 * An explicit null argument means the SQL spelling of it: `IS NULL`, and
 * `IS NOT NULL` for the negated operators. Non-null values and column
 * references on the right are untouched.
 */
let db: SQLiteAdapter

beforeAll(async () => {
  db = new SQLiteAdapter(':memory:')
  await db
    .query(
      'CREATE TABLE parcels (id INTEGER PRIMARY KEY, courier TEXT, weight REAL)',
    )
    .run()
  await db
    .query(
      'INSERT INTO parcels (id, courier, weight) VALUES ' +
        "(1, NULL, 2.5), (2, 'dhl', NULL), (3, NULL, NULL), (4, 'ups', 1.0)",
    )
    .run()
  __setTestDb(db)
})

afterAll(() => __resetTestDb())

describe('null in a where clause compiles to IS NULL', () => {
  test('where(col, null) emits IS NULL and binds nothing', () => {
    const { sql, params } = DB.table('parcels').where('courier', null).parse()

    expect(sql).toContain('IS NULL')
    expect(sql).not.toContain('= ?')
    expect(params).toEqual([])
  })

  test('and / or take the same path', () => {
    const { sql } = DB.table('parcels')
      .where('courier', null)
      .and('weight', null)
      .parse()

    expect(sql.match(/IS NULL/g)?.length).toBe(2)

    const { sql: orSql } = DB.table('parcels')
      .where('id', 1)
      .or('weight', null)
      .parse()

    expect(orSql).toContain('OR')
    expect(orSql).toContain('IS NULL')
  })

  test('eq(null) and neq(null) spell their null forms', () => {
    const { sql: eqSql } = DB.table('parcels')
      .where('courier', DB.eq(null))
      .parse()
    expect(eqSql).toContain('IS NULL')

    const { sql: neqSql } = DB.table('parcels')
      .where('courier', DB.neq(null))
      .parse()
    expect(neqSql).toContain('IS NOT NULL')
    // `IS NOT NULL` contains `IS NULL` as a substring, so pin the absence of
    // the broken form instead.
    expect(neqSql).not.toContain('<> ?')
  })

  test('a non-null value still binds as a parameter', () => {
    const { sql, params } = DB.table('parcels').where('courier', 'dhl').parse()

    expect(sql).toContain('= ?')
    expect(sql).not.toContain('IS NULL')
    expect(params).toEqual(['dhl'])
  })

  test('the rows actually come back — the failure this guards was silent', async () => {
    const nullCouriers = await DB.table('parcels')
      .where('courier', null)
      .select({ id: 'parcels.id' })

    expect(nullCouriers.map((r: any) => r.id).sort()).toEqual([1, 3])

    const withCourier = await DB.table('parcels')
      .where('courier', DB.neq(null))
      .select({ id: 'parcels.id' })

    expect(withCourier.map((r: any) => r.id).sort()).toEqual([2, 4])
  })
})
