import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { MySQLAdapter } from '../adapters/mysql'
import { PGAdapter } from '../adapters/pgsql'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/**
 * Set operations, `FULL OUTER JOIN` and window functions.
 *
 * The three constructs the builder had never been able to express. Each one
 * has a dialect split, and every rule asserted here was measured against live
 * MySQL 8 and Postgres 16 before it was written — the standard says one thing
 * and the servers say another in at least three places:
 *
 * | | SQLite | MySQL | Postgres |
 * | --- | --- | --- | --- |
 * | parenthesised operands | **no** | yes | yes |
 * | branch with its own LIMIT | needs a derived table | parens or derived | parens or derived |
 * | `INTERSECT ALL` / `EXCEPT ALL` | **no** | 8.0.31+ | yes |
 * | `FULL OUTER JOIN` | 3.39+ | **never** | yes |
 * | window functions | 3.25+ | 8.0+ | yes |
 */
describe('set operations: emitted SQL', () => {
  let db: SQLiteAdapter
  beforeAll(() => {
    db = new SQLiteAdapter(':memory:')
    __setTestDb(db)
  })
  afterAll(async () => {
    __resetTestDb()
    await db.close()
  })

  test('operands are bare — SQLite rejects parenthesised ones outright', () => {
    const { sql } = DB.from('a').union(DB.from('b')).parse()
    expect(sql).toBe('SELECT * FROM "a" UNION SELECT * FROM "b"')
    expect(sql).not.toContain('(SELECT')
  })

  test('a branch that limits itself is wrapped as a derived table', () => {
    // `SELECT … LIMIT 2 UNION SELECT …` is a syntax error on all three, and
    // the parenthesised fix works on only two. This form works on all three.
    const { sql } = DB.from('a').limit(2).union(DB.from('b')).parse()
    expect(sql).toBe(
      'SELECT * FROM (SELECT * FROM "a" LIMIT 2) AS "bakery_set_0"' +
        ' UNION SELECT * FROM "b"',
    )
  })

  test('…and so is one that orders itself, wherever it sits', () => {
    const { sql } = DB.from('a').union(DB.from('b').orderBy('b.id')).parse()
    expect(sql).toBe(
      'SELECT * FROM "a" UNION SELECT * FROM' +
        ' (SELECT * FROM "b" ORDER BY "b"."id" ASC) AS "bakery_set_1"',
    )
  })

  test('a third operand extends the set rather than nesting it', () => {
    // `a UNION b UNION c` is flat in SQL, evaluated left to right.
    const { sql } = DB.from('a')
      .union(DB.from('b'))
      .except(DB.from('c'))
      .parse()
    expect(sql).toBe(
      'SELECT * FROM "a" UNION SELECT * FROM "b" EXCEPT SELECT * FROM "c"',
    )
  })

  test('order and limit on the set land at the very end, unwrapped', () => {
    const { sql } = DB.from('a')
      .union(DB.from('b'))
      .orderBy('id', 'DESC')
      .limit(5, 2)
      .parse()
    expect(sql).toBe(
      'SELECT * FROM "a" UNION SELECT * FROM "b"' +
        ' ORDER BY "id" DESC LIMIT 5 OFFSET 2',
    )
  })

  test('parameters are collected across branches, in order', () => {
    const { sql, params } = DB.from('a')
      .where('a.id', DB.gt(1))
      .union(DB.from('b').where('b.id', DB.lt(9)))
      .parse()
    expect(params).toEqual([1, 9])
    expect(sql.indexOf('UNION')).toBeGreaterThan(0)
  })

  test('a bad sort direction is refused at the call site', () => {
    expect(() =>
      DB.from('a')
        .union(DB.from('b'))
        .orderBy('id', 'SIDEWAYS' as any),
    ).toThrow(/Invalid sort direction/)
  })

  test('an unsafe order column cannot reach the query', () => {
    expect(() =>
      DB.from('a')
        .union(DB.from('b'))
        .orderBy('(1) UNION SELECT password FROM users --'),
    ).toThrow()
  })

  test('INTERSECT ALL is refused on SQLite, by name', () => {
    // The server's own message is `near "ALL": syntax error`, which names the
    // keyword and not the construct.
    expect(() => DB.from('a').intersect(DB.from('b'), true).parse()).toThrow(
      /INTERSECT ALL is not supported/,
    )
  })

  test('EXCEPT ALL likewise, and UNION ALL is not gated', () => {
    expect(() => DB.from('a').except(DB.from('b'), true).parse()).toThrow(
      /EXCEPT ALL is not supported/,
    )
    expect(DB.from('a').unionAll(DB.from('b')).parse().sql).toContain(
      'UNION ALL',
    )
  })
})

describe('FULL OUTER JOIN', () => {
  let db: SQLiteAdapter
  beforeAll(() => {
    db = new SQLiteAdapter(':memory:')
    __setTestDb(db)
  })
  afterAll(async () => {
    __resetTestDb()
    await db.close()
  })

  test('emits FULL JOIN where the dialect has it', () => {
    const { sql } = DB.from('a').fullJoin('a.id', 'b.id').parse()
    expect(sql).toContain('FULL JOIN')
  })

  test('is refused on MySQL, naming the workaround', () => {
    const mysql = new MySQLAdapter()
    __setTestDb(mysql)
    try {
      expect(() => DB.from('a').fullJoin('a.id', 'b.id')).toThrow(
        /FULL OUTER JOIN is not supported/,
      )
    } finally {
      __setTestDb(db)
    }
  })

  test('an invented join type is refused', () => {
    // The type is interpolated straight into `${type} JOIN`, and the union that
    // restricts it is compile-time only — the same hole `orderBy`'s direction
    // had. Without the allow-list this was emitted verbatim.
    expect(() =>
      DB.from('a').join(
        'a.id',
        'b.id',
        undefined,
        'LEFT JOIN x ON 1=1 -- ' as any,
      ),
    ).toThrow(/Invalid join type/)
  })
})

describe('window functions: emitted SQL', () => {
  let db: SQLiteAdapter
  beforeAll(() => {
    db = new SQLiteAdapter(':memory:')
    __setTestDb(db)
  })
  afterAll(async () => {
    __resetTestDb()
    await db.close()
  })

  test('an aggregate over a partition', () => {
    const { sql } = DB.from('orders')
      .select({
        total: DB.over(DB.sum('orders.total'), {
          partitionBy: 'orders.userId',
          orderBy: 'orders.createdAt',
        }),
      })
      .parse()
    expect(sql).toContain(
      'SUM("orders"."total") OVER (PARTITION BY "orders"."user_id" ORDER BY "orders"."created_at" ASC)',
    )
  })

  test('a ranking function takes the window as its only argument', () => {
    const { sql } = DB.from('users')
      .select({ rn: DB.rowNumber({ orderBy: 'users.id DESC' }) })
      .parse()
    expect(sql).toContain('ROW_NUMBER() OVER (ORDER BY "users"."id" DESC)')
  })

  test('direction is read per column, so two can disagree', () => {
    const { sql } = DB.from('users')
      .select({ r: DB.rank({ orderBy: ['users.score DESC', 'users.id'] }) })
      .parse()
    expect(sql).toContain('ORDER BY "users"."score" DESC, "users"."id" ASC')
  })

  test('an empty window is legal and emits OVER ()', () => {
    const { sql } = DB.from('users').select({ n: DB.rowNumber() }).parse()
    expect(sql).toContain('ROW_NUMBER() OVER ()')
  })

  test('DB.window binds its arguments as parameters', () => {
    const { sql, params } = DB.from('orders')
      .select({
        prev: DB.window('LAG', [DB.col('orders.total'), 1], {
          orderBy: 'orders.createdAt',
        }),
      })
      .parse()
    expect(sql).toContain('LAG("orders"."total", ?) OVER (ORDER BY')
    expect(params).toEqual([1])
  })

  test('an unknown window function is refused, not interpolated', () => {
    expect(() =>
      DB.from('users')
        .select({ x: DB.window('DROP TABLE users --') })
        .parse(),
    ).toThrow(/Unsupported window function/)
  })

  test('an unsafe partition column cannot reach the query', () => {
    expect(() =>
      DB.rowNumber({ partitionBy: '(1) UNION SELECT password FROM users --' }),
    ).toThrow()
  })
})

/**
 * The same three constructs, executed. Emitted SQL being *shaped* right is not
 * the property that matters — a server accepting it is.
 */
describe('against a live server', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
    __resetTestDb()
  })

  function alive<T>(p: T | Promise<T>): Promise<T> {
    const t = setTimeout(() => {}, 30_000)
    return Promise.resolve(p).finally(() => clearTimeout(t))
  }

  const DIALECTS: [string, boolean, () => any, boolean, boolean][] = [
    // name, skip, open, supportsAll, supportsFullJoin
    ['SQLite', false, () => new SQLiteAdapter(':memory:'), false, true],
    ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL), true, false],
    ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL), true, true],
  ]

  for (const [name, skip, open, supportsAll, supportsFullJoin] of DIALECTS) {
    test.skipIf(skip)(`${name}: runs every construct it claims`, async () => {
      const db = open()
      const a = `bakery_so_a_${process.pid}`
      const b = `bakery_so_b_${process.pid}`
      const run = (s: string, ...p: unknown[]) => alive(db.query(s).run(...p))
      cleanup.push(async () => {
        await run(`DROP TABLE IF EXISTS ${a}`)
        await run(`DROP TABLE IF EXISTS ${b}`)
        await db.close?.()
      })

      await run(`DROP TABLE IF EXISTS ${a}`)
      await run(`DROP TABLE IF EXISTS ${b}`)
      await run(`CREATE TABLE ${a} (${db.quote('id')} INT NOT NULL)`)
      await run(`CREATE TABLE ${b} (${db.quote('id')} INT NOT NULL)`)
      for (const i of [1, 2, 3]) await run(`INSERT INTO ${a} VALUES (?)`, i)
      for (const i of [2, 3, 4]) await run(`INSERT INTO ${b} VALUES (?)`, i)

      __setTestDb(db)

      const ids = (rows: any[]) =>
        rows.map(r => Number(r.id)).sort((x, y) => x - y)

      const union = await alive(DB.from(a).union(DB.from(b)).array())
      expect({ d: name, r: ids(union as any[]) }).toEqual({
        d: name,
        r: [1, 2, 3, 4],
      })

      const unionAll = await alive(DB.from(a).unionAll(DB.from(b)).array())
      expect({ d: name, n: (unionAll as any[]).length }).toEqual({
        d: name,
        n: 6,
      })

      const inter = await alive(DB.from(a).intersect(DB.from(b)).array())
      expect({ d: name, r: ids(inter as any[]) }).toEqual({
        d: name,
        r: [2, 3],
      })

      const exc = await alive(DB.from(a).except(DB.from(b)).array())
      expect({ d: name, r: ids(exc as any[]) }).toEqual({ d: name, r: [1] })

      // A branch with its own LIMIT — the derived-table wrapper. Ordered, so
      // "the first two" is a defined set rather than whatever came back.
      const limited = await alive(
        DB.from(a).orderBy(`${a}.id`).limit(2).union(DB.from(b)).array(),
      )
      expect({ d: name, r: ids(limited as any[]) }).toEqual({
        d: name,
        r: [1, 2, 3, 4],
      })

      // Set-level ORDER BY and LIMIT.
      const top = await alive(
        DB.from(a).union(DB.from(b)).orderBy('id', 'DESC').limit(2).array(),
      )
      expect({ d: name, r: (top as any[]).map(r => Number(r.id)) }).toEqual({
        d: name,
        r: [4, 3],
      })

      // The `ALL` forms, where the dialect has them.
      if (supportsAll) {
        const ia = await alive(DB.from(a).intersect(DB.from(b), true).array())
        expect({ d: name, r: ids(ia as any[]) }).toEqual({ d: name, r: [2, 3] })
      } else {
        expect(() => DB.from(a).intersect(DB.from(b), true).parse()).toThrow(
          /not supported/,
        )
      }

      // FULL OUTER JOIN.
      if (supportsFullJoin) {
        const full = await alive(
          DB.from(a).fullJoin(`${a}.id`, `${b}.id`).array(),
        )
        expect({ d: name, n: (full as any[]).length }).toEqual({
          d: name,
          n: 4,
        })
      } else {
        expect(() => DB.from(a).fullJoin(`${a}.id`, `${b}.id`)).toThrow(
          /not supported/,
        )
      }

      // Window functions — supported everywhere.
      const ranked = (await alive(
        DB.from(a)
          .select({ id: `${a}.id`, rn: DB.rowNumber({ orderBy: `${a}.id` }) })
          .array(),
      )) as any[]
      expect({ d: name, r: ranked.map(r => Number(r.rn)).sort() }).toEqual({
        d: name,
        r: [1, 2, 3],
      })

      const running = (await alive(
        DB.from(a)
          .select({
            id: `${a}.id`,
            total: DB.over(DB.sum(`${a}.id`), { orderBy: `${a}.id` }),
          })
          .array(),
      )) as any[]
      expect({
        d: name,
        r: running.map(r => Number(r.total)).sort((x, y) => x - y),
      }).toEqual({ d: name, r: [1, 3, 6] })

      __resetTestDb()
    })
  }
})
