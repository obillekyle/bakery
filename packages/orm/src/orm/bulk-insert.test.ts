import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_QUERY_PARAMS } from '../adapters'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

/**
 * One `INSERT … VALUES (…),(…),…` carries a parameter per column per row, and
 * every driver here counts them in 16 bits. Past the ceiling they do not report
 * a limit, they report a wrapped number — `expected 54464 values, received
 * 120000`, which is `120000 - 65536` — or `too many SQL variables`. Neither
 * names the actual problem, and both arrive only once the data is real.
 *
 * A deliberately tiny ceiling does most of the work below: the real one is
 * 32,766, and a test that had to write eleven thousand rows to cross a single
 * boundary would be measuring patience rather than correctness. The one test
 * that uses the real ceiling writes 40,000 rows, which is exactly the size the
 * bug was first measured at.
 */
class TinyCeiling extends SQLiteAdapter {
  // Four rows per batch for a three-column record.
  override get maxQueryParams(): number {
    return 12
  }
}

let db: TinyCeiling

const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + from,
    label: `row-${i + from}`,
    n: (i + from) * 2,
  }))

beforeAll(async () => {
  db = new TinyCeiling(':memory:')
  __setTestDb(db)
  await db
    .query('CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)')
    .run()
})

afterAll(() => __resetTestDb())

describe('the parameter ceiling', () => {
  test('the adapter publishes one, below the 16-bit wrap', () => {
    // The wrap is the reason for the number: anything at or above 65,536 turns
    // a limit into a corrupted count.
    expect(DEFAULT_MAX_QUERY_PARAMS).toBeLessThan(65536)
    expect(new SQLiteAdapter(':memory:').maxQueryParams).toBe(
      DEFAULT_MAX_QUERY_PARAMS,
    )
  })

  test('an adapter may narrow it, and the builder obeys the override', () => {
    expect(db.maxQueryParams).toBe(12)
    expect(DB.Insert.into('big').values(rows(4)).parseAll()).toHaveLength(1)
    expect(DB.Insert.into('big').values(rows(5)).parseAll()).toHaveLength(2)
  })
})

describe('parseAll() batches at the boundary', () => {
  test('no batch exceeds the ceiling, and the last one holds the remainder', () => {
    const batches = DB.Insert.into('big').values(rows(10)).parseAll()
    expect(batches).toHaveLength(3)
    expect(batches.map(b => b.params.length)).toEqual([12, 12, 6])
    for (const b of batches) expect(b.params.length).toBeLessThanOrEqual(12)
  })

  test('every batch is a complete statement with the same column list', () => {
    const batches = DB.Insert.into('big').values(rows(10)).parseAll()
    for (const b of batches) {
      expect(
        b.sql.startsWith('INSERT INTO "big" ("id", "label", "n") VALUES '),
      ).toBe(true)
    }
    expect(batches[0]!.sql.split('(?, ?, ?)').length - 1).toBe(4)
    expect(batches[2]!.sql.split('(?, ?, ?)').length - 1).toBe(2)
  })

  test('the column list is the union over every record, not the batch', () => {
    // A per-batch union would change the statement's shape halfway through —
    // the row that introduces a column would silently drop it in the batches
    // that came before.
    // Two columns, so six records per batch: the column arrives in the record
    // that lands in the *second* batch, and the first batch has to know about
    // it anyway.
    const records = [
      ...Array.from({ length: 6 }, (_, i) => ({ id: i })),
      { id: 6, label: 'x' },
    ]
    const batches = DB.Insert.into('big').values(records).parseAll()
    expect(batches).toHaveLength(2)
    for (const b of batches) expect(b.sql).toContain('("id", "label")')
    // The records without it bind NULL rather than shifting every later value
    // one position left.
    expect(batches[0]!.params).toEqual([
      0,
      null,
      1,
      null,
      2,
      null,
      3,
      null,
      4,
      null,
      5,
      null,
    ])
    expect(batches[1]!.params).toEqual([6, 'x'])
  })

  test('a single-batch insert is unchanged', () => {
    const one = DB.Insert.into('big').values({ id: 1, label: 'a', n: 2 })
    expect(one.parseAll()).toHaveLength(1)
    expect(one.parse().sql).toBe(
      'INSERT INTO "big" ("id", "label", "n") VALUES (?, ?, ?)',
    )
  })
})

describe('parse() refuses what it cannot represent', () => {
  test('it throws rather than hand back one batch of several', () => {
    // A caller holding {sql, params} runs it themselves; returning the first
    // third of their rows is the exact failure this change exists to remove.
    expect(() => DB.Insert.into('big').values(rows(100)).parse()).toThrow(
      /parseAll\(\)/,
    )
  })

  test('an empty insert still fails, and says so', () => {
    expect(() => DB.Insert.into('big').values([]).parse()).toThrow(
      /Empty insert/,
    )
  })
})

describe('a batched insert writes every row, exactly once', () => {
  test('30 rows across 8 batches', async () => {
    await db.query('DELETE FROM big').run()
    const result = await DB.Insert.into('big').values(rows(30)).run()

    expect(result.changes).toBe(30)
    const count: any = await db.query('SELECT COUNT(*) AS c FROM big').get()
    const distinct: any = await db
      .query('SELECT COUNT(DISTINCT id) AS c FROM big')
      .get()
    const sum: any = await db.query('SELECT SUM(n) AS s FROM big').get()
    expect(Number(count.c)).toBe(30)
    expect(Number(distinct.c)).toBe(30)
    // Duplication and truncation both change this; the row count alone catches
    // neither on its own.
    expect(Number(sum.s)).toBe(29 * 30)

    const last: any = await db.query('SELECT * FROM big WHERE id = 29').get()
    expect(last.label).toBe('row-29')
  })

  test('a failing batch rolls the earlier ones back', async () => {
    // The transaction is the whole reason batching is allowed to be invisible:
    // without it, "insert these rows" would half-succeed.
    await db.query('DELETE FROM big').run()
    const conflicting = [...rows(20), { id: 3, label: 'dup', n: 0 }]
    await expect(
      DB.Insert.into('big').values(conflicting).run(),
    ).rejects.toThrow()
    const count: any = await db.query('SELECT COUNT(*) AS c FROM big').get()
    expect(Number(count.c)).toBe(0)
  })

  test('40,000 rows at the real ceiling — the size the bug was measured at', async () => {
    // 120,000 parameters in one statement reported "expected 54464 values,
    // received 120000". Plain SQLiteAdapter, real 32,766 ceiling, 13 batches.
    const real = new SQLiteAdapter(':memory:')
    __setTestDb(real)
    try {
      await real
        .query(
          'CREATE TABLE huge (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)',
        )
        .run()
      const result = await DB.Insert.into('huge').values(rows(40_000)).run()
      expect(result.changes).toBe(40_000)

      const count: any = await real
        .query('SELECT COUNT(*) AS c FROM huge')
        .get()
      const sum: any = await real.query('SELECT SUM(n) AS s FROM huge').get()
      expect(Number(count.c)).toBe(40_000)
      expect(Number(sum.s)).toBe(39_999 * 40_000)
    } finally {
      __setTestDb(db)
      await real.close()
    }
  })
})

describe('RETURNING survives batching', () => {
  test('rows accumulate across batches, in batch order', async () => {
    await db.query('DELETE FROM big').run()
    const back = await DB.Insert.into('big')
      .values(rows(10))
      .returning('id')
      .array()
    expect(back).toHaveLength(10)
    expect(back.map((r: any) => Number(r.id))).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    )
  })

  test('fetch() runs every batch, not just the one holding the row', async () => {
    await db.query('DELETE FROM big').run()
    const first: any = await DB.Insert.into('big')
      .values(rows(10))
      .returning('id')
      .fetch()
    expect(Number(first.id)).toBe(0)
    const count: any = await db.query('SELECT COUNT(*) AS c FROM big').get()
    expect(Number(count.c)).toBe(10)
  })
})

describe('upsert carries its conflict clause on every batch', () => {
  test('the clause is on each statement, not only the first', () => {
    const batches = DB.Insert.into('big')
      .values(rows(10))
      .upsert(['id'])
      .parseAll()
    expect(batches).toHaveLength(3)
    for (const b of batches) {
      expect(b.sql).toContain('ON CONFLICT ("id") DO UPDATE SET')
    }
  })

  test('a batched upsert still upserts, against a real database', async () => {
    await db.query('DROP TABLE IF EXISTS up_big').run()
    await db
      .query('CREATE TABLE up_big (id INTEGER NOT NULL, label TEXT, n INTEGER)')
      .run()
    await db.query('CREATE UNIQUE INDEX up_big_id ON up_big (id)').run()

    await DB.Insert.into('up_big')
      .values(rows(30).map(r => ({ ...r, label: 'first' })))
      .upsert(['id'])
      .run()
    await DB.Insert.into('up_big')
      .values(rows(30).map(r => ({ ...r, label: 'second' })))
      .upsert(['id'])
      .run()

    const count: any = await db.query('SELECT COUNT(*) AS c FROM up_big').get()
    const updated: any = await db
      .query("SELECT COUNT(*) AS c FROM up_big WHERE label = 'second'")
      .get()
    expect(Number(count.c)).toBe(30)
    // Not "the last batch won" — every row, in every batch, took the update.
    expect(Number(updated.c)).toBe(30)
    await db.query('DROP TABLE IF EXISTS up_big').run()
  })
})

describe('values() takes an array as readily as a spread', () => {
  test('one array of records is the records, not one record', () => {
    // Previously `values(rows)` bound the array as a single record and failed
    // with `table big has no column named 0`.
    const { sql, params } = DB.Insert.into('big')
      .values([
        { id: 1, label: 'a', n: 1 },
        { id: 2, label: 'b', n: 2 },
      ])
      .parse()
    expect(sql).toBe(
      'INSERT INTO "big" ("id", "label", "n") VALUES (?, ?, ?), (?, ?, ?)',
    )
    expect(params).toEqual([1, 'a', 1, 2, 'b', 2])
  })

  test('the spread form is unchanged', () => {
    const spread = DB.Insert.into('big')
      .values({ id: 1, label: 'a', n: 1 }, { id: 2, label: 'b', n: 2 })
      .parse()
    const array = DB.Insert.into('big')
      .values([
        { id: 1, label: 'a', n: 1 },
        { id: 2, label: 'b', n: 2 },
      ])
      .parse()
    expect(spread).toEqual(array)
  })

  test('both forms actually write the same rows', async () => {
    await db.query('DELETE FROM big').run()
    await DB.Insert.into('big').values(rows(4)).run()
    await DB.Insert.into('big')
      .values(...rows(4, 4))
      .run()
    await DB.Insert.into('big').values(rows(1, 8)[0]!).run()
    const count: any = await db.query('SELECT COUNT(*) AS c FROM big').get()
    expect(Number(count.c)).toBe(9)
  })

  test('anything that is neither is rejected by name', () => {
    // Silence was the one option to rule out: a mixed call used to produce
    // columns called `0` and `1`.
    expect(() =>
      (DB.Insert.into('big').values as any)(rows(2), { id: 9 }),
    ).toThrow(/values\(rows\)/)
    expect(() => (DB.Insert.into('big').values as any)(1, 2)).toThrow(
      /values\(\) takes records/,
    )
    expect(() => (DB.Insert.into('big').values as any)(null)).toThrow(
      /values\(\) takes records/,
    )
  })
})
