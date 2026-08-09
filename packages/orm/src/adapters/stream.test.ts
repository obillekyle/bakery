import { afterAll, describe, expect, test } from 'bun:test'
import { DEFAULT_STREAM_CHUNK, pagedIterate, SQLAdapter } from './base'
import { MySQLAdapter } from './mysql'
import { PGAdapter } from './pgsql'
import { SQLiteAdapter } from './sqlite'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/**
 * `iterate()` — and above it `QBExecutable.iterable()` — had never worked.
 *
 * The adapters handed their raw Bun query object to `for await`, and an
 * `SQLQuery` is a thenable with no `Symbol.asyncIterator`, so every dialect
 * threw `… .iterate is not a function`. Nothing tested it, which is why a
 * published API could sit broken indefinitely.
 *
 * It now pages. These tests assert the two properties that distinguish paging
 * from "fetch everything and pretend": rows come back complete and in order,
 * and the whole result is never held at once.
 */
describe('pagedIterate', () => {
  /** Records the statements it is asked to run, and serves rows from an array. */
  function stubAll(total: number) {
    const seen: { sql: string; params: unknown[] }[] = []
    const rows = Array.from({ length: total }, (_, i) => ({ id: i + 1 }))
    const all: SQLAdapter.Executor['all'] = async (sql, params = []) => {
      seen.push({ sql, params })
      const limit = Number(params[params.length - 2])
      const offset = Number(params[params.length - 1])
      return rows.slice(offset, offset + limit)
    }
    return { all, seen, rows }
  }

  test('walks every row, in order, across chunk boundaries', async () => {
    const { all } = stubAll(25)
    const out: unknown[] = []
    for await (const row of pagedIterate(all, 10)('SELECT * FROM t')) {
      out.push((row as { id: number }).id)
    }
    expect(out).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
  })

  test('wraps the statement in a derived table rather than appending', async () => {
    // Appending ` LIMIT ? OFFSET ?` to a statement that already ends in LIMIT
    // is a syntax error. The derived table composes instead.
    const { all, seen } = stubAll(3)
    for await (const _ of pagedIterate(all, 10)('SELECT * FROM t LIMIT 5')) {
      // drain
    }
    expect(seen[0]!.sql).toBe(
      'SELECT * FROM (SELECT * FROM t LIMIT 5) AS bakery_stream LIMIT ? OFFSET ?',
    )
  })

  test("the caller's parameters come before the window's two", async () => {
    const { all, seen } = stubAll(0)
    for await (const _ of pagedIterate(all, 10)('SELECT * FROM t WHERE a = ?', [
      'x',
    ])) {
      // drain
    }
    // Order is load-bearing on Postgres: `?` is rewritten to `$1, $2, $3` left
    // to right, so a window parameter placed first would renumber the caller's.
    expect(seen[0]!.params).toEqual(['x', 10, 0])
  })

  test('a short chunk ends the walk without an extra round trip', async () => {
    const { all, seen } = stubAll(15)
    for await (const _ of pagedIterate(all, 10)('SELECT * FROM t')) {
      // drain
    }
    // 10 then 5 — and it stops, rather than asking for an empty third page.
    expect(seen).toHaveLength(2)
  })

  test('an exactly-full last chunk does cost one more round trip', async () => {
    // The honest cost of the check above. 20 rows in chunks of 10 cannot be
    // distinguished from "more to come" without asking.
    const { all, seen } = stubAll(20)
    for await (const _ of pagedIterate(all, 10)('SELECT * FROM t')) {
      // drain
    }
    expect(seen).toHaveLength(3)
  })

  test('never holds more than one chunk', async () => {
    // The property that makes this worth having at all. If it fetched
    // everything and yielded from an array, `live` would reach 1000.
    let live = 0
    let peak = 0
    const all: SQLAdapter.Executor['all'] = async (_sql, params = []) => {
      const limit = Number(params[params.length - 2])
      const offset = Number(params[params.length - 1])
      const rows = Array.from(
        { length: Math.max(0, Math.min(limit, 1000 - offset)) },
        (_, i) => ({ id: offset + i + 1 }),
      )
      live = rows.length
      peak = Math.max(peak, live)
      return rows
    }
    let count = 0
    for await (const _ of pagedIterate(all, 50)('SELECT * FROM t')) count++
    expect(count).toBe(1000)
    expect(peak).toBe(50)
  })

  test('the default chunk size is used when none is given', async () => {
    const { all, seen } = stubAll(1)
    for await (const _ of pagedIterate(all)('SELECT * FROM t')) {
      // drain
    }
    expect(seen[0]!.params).toEqual([DEFAULT_STREAM_CHUNK, 0])
  })
})

/**
 * The same walk against real servers, because the derived-table wrapper is the
 * part a dialect can reject — MySQL requires the alias, and a statement that
 * already carries `ORDER BY` or `LIMIT` has to survive being wrapped.
 */
describe('iterate() against a live server', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
  })

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
    test.skipIf(skip)(`${name}: streams a table in chunks`, async () => {
      const db = open()
      const t = `bakery_stream_${process.pid}`
      const run = (s: string, ...p: unknown[]) => alive(db.query(s).run(...p))
      cleanup.push(async () => {
        await run(`DROP TABLE IF EXISTS ${t}`)
        await db.close?.()
      })

      await run(`DROP TABLE IF EXISTS ${t}`)
      await run(`CREATE TABLE ${t} (${db.quote('id')} INT NOT NULL)`)
      for (let i = 1; i <= 12; i++) await run(`INSERT INTO ${t} VALUES (?)`, i)

      // Chunk smaller than the table, so the boundary is actually crossed.
      const iterate = pagedIterate(
        (sql, params) => db.execute.all(sql, params),
        5,
      )

      const plain: number[] = []
      for await (const row of iterate(
        `SELECT * FROM ${t} ORDER BY ${db.quote('id')}`,
      )) {
        plain.push(Number((row as any).id))
      }
      expect({ dialect: name, rows: plain }).toEqual({
        dialect: name,
        rows: Array.from({ length: 12 }, (_, i) => i + 1),
      })

      // Bound parameters, and a statement that already limits itself.
      const filtered: number[] = []
      for await (const row of iterate(
        `SELECT * FROM ${t} WHERE ${db.quote('id')} > ? ORDER BY ${db.quote('id')} LIMIT 6`,
        [3],
      )) {
        filtered.push(Number((row as any).id))
      }
      expect({ dialect: name, rows: filtered }).toEqual({
        dialect: name,
        rows: [4, 5, 6, 7, 8, 9],
      })
    })
  }
})

/**
 * The published API, end to end.
 *
 * `QBExecutable.iterable()` is what `docs/orm/queries.md` tells people to use
 * for a result set they do not want in memory — and the doc example only ever
 * *compiled*, so it documented something that threw. This runs it.
 */
describe('DB…iterable()', () => {
  test('streams a built query through the ORM', async () => {
    const { __resetTestDb, __setTestDb } = await import('../connection')
    const { DB } = await import('../orm')

    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE stream_items (id INTEGER PRIMARY KEY, n TEXT)').run()
    for (let i = 1; i <= 7; i++) {
      await db.query('INSERT INTO stream_items (id, n) VALUES (?, ?)').run(i, `x${i}`)
    }
    __setTestDb(db)
    try {
      const seen: number[] = []
      for await (const row of DB.from('stream_items')
        .where('id', DB.gt(2))
        .iterable()) {
        seen.push((row as any).id)
      }
      expect(seen).toEqual([3, 4, 5, 6, 7])
    } finally {
      __resetTestDb()
      await db.close()
    }
  })

  test('keys are camel-cased on the way out, as they are for array()', async () => {
    const { __resetTestDb, __setTestDb } = await import('../connection')
    const { DB } = await import('../orm')

    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE stream_cased (id INTEGER PRIMARY KEY, given_name TEXT)').run()
    await db.query('INSERT INTO stream_cased VALUES (?, ?)').run(1, 'ada')
    __setTestDb(db)
    try {
      const rows: any[] = []
      for await (const row of DB.from('stream_cased').iterable()) rows.push(row)
      expect(rows[0].givenName).toBe('ada')
    } finally {
      __resetTestDb()
      await db.close()
    }
  })
})
