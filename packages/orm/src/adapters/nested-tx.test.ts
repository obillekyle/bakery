import { afterAll, describe, expect, test } from 'bun:test'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from '../orm/query'
import type { SQLAdapter } from './base'
import { MySQLAdapter } from './mysql'
import { PGAdapter } from './pgsql'
import { SQLiteAdapter } from './sqlite'

/**
 * Nested transactions, on every dialect.
 *
 * Before `SQLAdapter.transaction` learned to dispatch, a `transaction` inside a
 * `transaction` died on Bun's own refusal — `cannot call begin inside a
 * transaction use savepoint() instead`, identical wording on all three servers.
 * That is not an exotic shape: it is any two transactional functions calling
 * each other.
 *
 * The first test here is the crash. The ones after it are the reason savepoints
 * are the right fix rather than "silently reuse the outer transaction", which
 * would also stop the crash while quietly making an inner rollback tear down
 * work the outer had already done and meant to keep.
 *
 * Live servers are gated per dialect; without a URL those report skipped, and a
 * skip is not a pass.
 */

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

interface Dialect {
  name: string
  skip: boolean
  open(): SQLAdapter
  ddl(table: string): string
}

/**
 * Await `promise` with an unrelated timer pending, and never remove this
 * without re-checking MySQL.
 *
 * Bun 1.3.14's MySQL driver does not resume the *first query issued after a
 * transaction* unless the event loop has other work pending. Not slow —
 * indefinite: a bare `await db.query(…).all()` after `await db.transaction(…)`
 * never settles and no per-test timeout fires, so `bun test` sits there until
 * something kills it. A single unrelated `setTimeout` is enough to unwedge it.
 *
 * Two things established before this went in. It is **not** caused by
 * savepoints — the minimal reproduction is a plain non-nested transaction —
 * and it is **not** caused by the change this file tests: the same reproduction
 * hangs identically against the adapters at HEAD.
 *
 * It has never been seen outside a test because a server always has pending
 * work; a test process that has just awaited its last statement has none.
 * That also makes it a harness workaround rather than a weakened assertion:
 * every expectation below is still checked against a live server.
 */
function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

const DIALECTS: Dialect[] = [
  {
    name: 'SQLite',
    skip: false,
    open: () => new SQLiteAdapter(':memory:'),
    ddl: t => `CREATE TABLE ${t} (v INTEGER)`,
  },
  {
    name: 'MySQL',
    skip: !MYSQL_URL,
    open: () => new MySQLAdapter(MYSQL_URL),
    // InnoDB explicitly: MyISAM ignores savepoints along with the rest of
    // transactions, so a table on it would pass the "did not throw" test and
    // fail every assertion about what rolled back.
    ddl: t => `CREATE TABLE ${t} (v INT) ENGINE=InnoDB`,
  },
  {
    name: 'Postgres',
    skip: !PGSQL_URL,
    open: () => new PGAdapter(PGSQL_URL),
    ddl: t => `CREATE TABLE ${t} (v INT)`,
  },
]

for (const dialect of DIALECTS) {
  describe(`${dialect.name}: nested transactions`, () => {
    const cleanup: Array<() => Promise<unknown> | unknown> = []
    afterAll(async () => {
      for (const fn of cleanup) await fn()
    })

    // Each test gets its own table and its own connection — and every
    // statement in that test has to go through the returned `db`. A second
    // `dialect.open()` would not be a second view of the same data: SQLite
    // gives every `:memory:` connection a private database.
    async function fixture(suffix: string) {
      const db = dialect.open()
      const table = `bakery_nested_${suffix}_${process.pid}`
      cleanup.push(async () => {
        await alive(db.query(`DROP TABLE IF EXISTS ${table}`).run())
        await db.close?.()
      })
      await db.query(`DROP TABLE IF EXISTS ${table}`).run()
      await db.query(dialect.ddl(table)).run()
      return {
        db,
        table,
        insert: (tx: SQLAdapter, v: number) =>
          tx.query(`INSERT INTO ${table} (v) VALUES (?)`).run(v),
        // Every call site is a read *after* a transaction, which is exactly the
        // position `alive` exists for.
        rows: async () =>
          (
            (await alive(
              db.query(`SELECT v FROM ${table} ORDER BY v`).all(),
            )) as { v: number }[]
          ).map(r => Number(r.v)),
      }
    }

    test.skipIf(dialect.skip)(
      'a transaction inside a transaction runs',
      async () => {
        const { db, insert, rows } = await fixture('basic')

        await db.transaction(async outer => {
          await insert(outer, 1)
          await outer.transaction(async inner => {
            await insert(inner, 2)
          })
        })

        expect(await rows()).toEqual([1, 2])
      },
    )

    test.skipIf(dialect.skip)(
      'an inner rollback keeps the outer transaction’s work',
      async () => {
        const { db, insert, rows } = await fixture('inner')

        await db.transaction(async outer => {
          await insert(outer, 1)
          // Caught here on purpose: this is the whole difference between a
          // savepoint and pretending the nesting is not there. The inner block
          // is allowed to fail as a unit without costing the outer its row.
          try {
            await outer.transaction(async inner => {
              await insert(inner, 2)
              throw new Error('inner fails')
            })
          } catch (error) {
            expect((error as Error).message).toBe('inner fails')
          }
          await insert(outer, 3)
        })

        expect(await rows()).toEqual([1, 3])
      },
    )

    test.skipIf(dialect.skip)(
      'an outer rollback discards the inner block that succeeded',
      async () => {
        const { db, insert, rows } = await fixture('outer')

        let caught: string | undefined
        try {
          await db.transaction(async outer => {
            await insert(outer, 1)
            await outer.transaction(async inner => {
              await insert(inner, 2)
            })
            throw new Error('outer fails')
          })
        } catch (error) {
          caught = (error as Error).message
        }
        expect(caught).toBe('outer fails')

        // A released savepoint is not a commit. Nothing survives the outer.
        expect(await rows()).toEqual([])
      },
    )

    test.skipIf(dialect.skip)('nests more than one level deep', async () => {
      const { db, insert, rows } = await fixture('deep')

      await db.transaction(async a => {
        await insert(a, 1)
        await a.transaction(async b => {
          await insert(b, 2)
          await b.transaction(async c => {
            await insert(c, 3)
            try {
              await c.transaction(async d => {
                await insert(d, 4)
                throw new Error('deepest fails')
              })
            } catch {
              // Asserted by the row set below: only 4 is missing.
            }
          })
        })
      })

      expect(await rows()).toEqual([1, 2, 3])
    })
  })
}

/**
 * The path an application actually takes. `DB.transaction` resolves its
 * connection through `getActiveDb()`, which returns the *transaction* adapter
 * when one is open — so a nested `DB.transaction` is what reached the broken
 * `BEGIN`, without either function knowing the other existed.
 */
describe('DB.transaction nests through getActiveDb', () => {
  test('composed transactional functions no longer collide', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE users (name TEXT)').run()
    __setTestDb(db)

    // Deliberately written as two functions that each open a transaction and
    // neither is aware of the other. That is the shape that used to crash.
    const createUser = (name: string) =>
      DB.transaction(tx =>
        tx.query('INSERT INTO users (name) VALUES (?)').run(name),
      )
    const importUsers = (names: string[]) =>
      DB.transaction(async () => {
        for (const name of names) await createUser(name)
      })

    await importUsers(['ada', 'grace'])

    const rows = (await db
      .query('SELECT name FROM users ORDER BY name')
      .all()) as {
      name: string
    }[]
    expect(rows.map(r => r.name)).toEqual(['ada', 'grace'])

    __resetTestDb()
    await db.close?.()
  })
})
