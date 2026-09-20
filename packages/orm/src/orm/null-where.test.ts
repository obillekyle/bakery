import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

/**
 * `where(col, null)` used to compile to a bound NULL: `col = ?` with a null
 * parameter, which SQL's three-valued logic makes UNKNOWN for every row. The
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

  test('the rows actually come back: the failure this guards was silent', async () => {
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

/**
 * The same rule, on the two paths that never had it.
 *
 * `null-where` reached `formatClause` in query.ts and stopped there, and the
 * tests above only ever asked a `SELECT`. `orm/mutation.ts` compiles its own
 * WHERE twice (once for `UpdateExecutable`, once for `DeleteExecutable`), and
 * both emitted `= ?` with a bound NULL, which matches no row in three-valued
 * logic. So an update changed nothing and a delete removed nothing, each
 * reporting zero changes, which a caller cannot tell from a conflict.
 *
 * Asserted by executing, not by reading the SQL: the text is the mechanism and
 * the surviving rows are the claim.
 */
describe('null in a mutation where clause', () => {
  test('UPDATE ... WHERE col = null writes the NULL rows', async () => {
    const before = await DB.table('parcels')
      .where('courier', null)
      .select({ id: 'parcels.id' })
    expect(before.map((r: any) => r.id).sort()).toEqual([1, 3])

    const res = await DB.Update.table('parcels')
      .set({ courier: 'assigned' })
      .where('courier', null)
      .run()

    expect((res as any).changes).toBe(2)

    const after = await DB.table('parcels')
      .where('courier', null)
      .select({ id: 'parcels.id' })
    expect(after).toEqual([])

    // Put them back for the delete test below, which shares the fixture.
    await DB.Update.table('parcels')
      .set({ courier: null })
      .where('courier', 'assigned')
      .run()
  })

  test('the emitted SQL binds nothing for the null', () => {
    const { sql, params } = DB.Update.table('parcels')
      .set({ courier: 'x' })
      .where('courier', null)
      .parse()

    // Scoped to the WHERE. The SET clause binds `courier = ?` legitimately (    // that is the value being written), so asserting over the whole statement
    // tests the wrong half.
    const where = sql.slice(sql.indexOf(' WHERE '))
    expect(where).toContain('IS NULL')
    expect(where).not.toContain('?')
    // Only the SET value binds; the null contributed no parameter.
    expect(params).toEqual(['x'])
  })

  test('DELETE ... WHERE col = null removes the NULL rows', async () => {
    const res = await DB.Delete.from('parcels').where('courier', null).run()
    expect((res as any).changes).toBe(2)

    const left = await DB.table('parcels').select({ id: 'parcels.id' })
    expect(left.map((r: any) => r.id).sort()).toEqual([2, 4])
  })

  test('neq(null) spells IS NOT NULL on a mutation too', () => {
    const { sql } = DB.Delete.from('parcels')
      .where('courier', DB.neq(null))
      .parse()
    expect(sql).toContain('IS NOT NULL')
  })
})
