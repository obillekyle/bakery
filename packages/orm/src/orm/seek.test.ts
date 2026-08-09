import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './query'

/**
 * Cursor (keyset) pagination.
 *
 * `paginate()` is offset-based and stays that way; this is the answer for the
 * case where offset stops being reasonable. Two properties matter and both are
 * asserted against a real database rather than against emitted SQL: pages do
 * not overlap, and a row deleted mid-scan does not make a later page skip a
 * different row — which offset paging does by construction.
 */
describe('seek()', () => {
  let db: any
  beforeAll(async () => {
    db = new SQLiteAdapter(':memory:')
    await db
      .query('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)')
      .run()
    for (let i = 1; i <= 25; i++) {
      await db
        .query('INSERT INTO items (id, name) VALUES (?, ?)')
        .run(i, `n${i}`)
    }
    __setTestDb(db)
  })
  afterAll(async () => {
    __resetTestDb()
    await db.close?.()
  })

  test('a null cursor is the first page and does not filter', async () => {
    const { sql, params } = DB.from('items').seek('id', null, 5).parse()
    expect(sql).not.toContain('WHERE')
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('LIMIT 5')
    expect(params).toEqual([])

    const rows = (await DB.from('items').seek('id', null, 5).array()) as any[]
    expect(rows.map(r => r.id)).toEqual([1, 2, 3, 4, 5])
  })

  test('undefined is the first page too, so one call site serves both', async () => {
    const rows = (await DB.from('items')
      .seek('id', undefined, 3)
      .array()) as any[]
    expect(rows.map(r => r.id)).toEqual([1, 2, 3])
  })

  test('a cursor binds as a parameter, not as SQL text', () => {
    const { sql, params } = DB.from('items').seek('id', 5, 5).parse()
    expect(sql).toContain('>')
    expect(params).toEqual([5])
  })

  test('walks the whole table in non-overlapping pages', async () => {
    const seen: number[] = []
    let cursor: number | null = null
    for (let guard = 0; guard < 20; guard++) {
      const rows = (await DB.from('items')
        .seek('id', cursor, 7)
        .array()) as any[]
      if (!rows.length) break
      seen.push(...rows.map(r => r.id))
      cursor = rows.at(-1)!.id
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(new Set(seen).size).toBe(25)
  })

  test('DESC seeks backwards', async () => {
    const first = (await DB.from('items')
      .seek('id', null, 4, 'DESC')
      .array()) as any[]
    expect(first.map(r => r.id)).toEqual([25, 24, 23, 22])
    const next = (await DB.from('items')
      .seek('id', 22, 4, 'DESC')
      .array()) as any[]
    expect(next.map(r => r.id)).toEqual([21, 20, 19, 18])
  })

  test('a bad direction fails at the call site', () => {
    expect(() =>
      DB.from('items').seek('id', null, 5, 'SIDEWAYS' as any),
    ).toThrow(/Invalid seek direction/)
  })

  test('an unsafe cursor column cannot reach the query', () => {
    expect(() =>
      DB.from('items').seek('id; DROP TABLE items --' as any, null, 5),
    ).toThrow()
  })

  test('composes with an existing where clause', async () => {
    const rows = (await DB.from('items')
      .where('id', DB.lte(10))
      .seek('id', 5, 100)
      .array()) as any[]
    expect(rows.map(r => r.id)).toEqual([6, 7, 8, 9, 10])
  })

  test('a row deleted mid-scan does not make the next page skip one', async () => {
    // The property offset paging cannot have. With LIMIT/OFFSET, deleting a row
    // from page 1 shifts every later page back by one and a row is never seen.
    const page1 = (await DB.from('items').seek('id', null, 5).array()) as any[]
    expect(page1.map(r => r.id)).toEqual([1, 2, 3, 4, 5])

    await db.query('DELETE FROM items WHERE id = ?').run(2)

    const page2 = (await DB.from('items')
      .seek('id', page1.at(-1)!.id, 5)
      .array()) as any[]
    expect(page2.map(r => r.id)).toEqual([6, 7, 8, 9, 10])

    // Restore, so the offset comparison below reads against the same table.
    await db.query('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'n2')
  })

  test('offset paging skips a row in that same scenario', async () => {
    // Not a test of seek — a test that the problem seek solves is real, so the
    // one above is not asserting a difference that does not exist.
    const page1 = (await DB.from('items').paginate(1, 5).array()) as any[]
    expect(page1.map(r => r.id)).toEqual([1, 2, 3, 4, 5])

    await db.query('DELETE FROM items WHERE id = ?').run(2)
    const page2 = (await DB.from('items').paginate(2, 5).array()) as any[]
    // 6 is gone: everything shifted back one when row 2 disappeared.
    expect(page2.map(r => r.id)).toEqual([7, 8, 9, 10, 11])

    await db.query('INSERT INTO items (id, name) VALUES (?, ?)').run(2, 'n2')
  })
})
