import { afterAll, describe, expect, test } from 'bun:test'
import type { SQLAdapter } from '../adapters/base'
import { MySQLAdapter } from '../adapters/mysql'
import { PGAdapter } from '../adapters/pgsql'
import { SQLiteAdapter } from '../adapters/sqlite'
import { Field } from '../field'
import { foreign } from '../schema-util'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/** See adapters/nested-tx.test.ts — Bun's MySQL driver needs a pending timer. */
function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

const col = (table: string, column: string) =>
  ({ __table: table, __column: column }) as any

/**
 * Composite foreign keys.
 *
 * `cols` and `refCols` have been arrays all along and every adapter emits a
 * multi-column `FOREIGN KEY (a, b) REFERENCES t (x, y)` — but there was no way
 * to *declare* one, so "works by construction" was the strongest claim anyone
 * could make. These tests replace construction with a live server.
 */
describe('foreign() composite declaration', () => {
  test('single column still produces a single-column key', () => {
    const fk: any = foreign(col('posts', 'authorId')).references(
      col('users', 'id'),
    )
    expect(fk.cols).toEqual(['authorId'])
    expect(fk.refCols).toEqual(['id'])
    expect(fk.table).toBe('posts')
    expect(fk.refTable).toBe('users')
  })

  test('actions still reach a single-column key', () => {
    const fk: any = foreign(col('posts', 'authorId')).references(
      col('users', 'id'),
      { onDelete: 'CASCADE' },
    )
    expect(fk.onDelete).toBe('CASCADE')
  })

  test('two columns produce a two-column key, in order', () => {
    const fk: any = foreign(
      col('items', 'orderId'),
      col('items', 'sku'),
    ).references(col('orders', 'id'), col('orders', 'sku'))
    expect(fk.cols).toEqual(['orderId', 'sku'])
    expect(fk.refCols).toEqual(['id', 'sku'])
  })

  test('actions reach a composite key too', () => {
    const fk: any = foreign(
      col('items', 'orderId'),
      col('items', 'sku'),
    ).references(col('orders', 'id'), col('orders', 'sku'), {
      onDelete: 'CASCADE',
      onUpdate: 'RESTRICT',
    })
    expect(fk.cols).toHaveLength(2)
    expect(fk.onDelete).toBe('CASCADE')
    expect(fk.onUpdate).toBe('RESTRICT')
  })

  test('a mismatched column count is refused by name', () => {
    // Silently emitting FOREIGN KEY (a, b) REFERENCES t (x) is a server error
    // much later, with nothing pointing at the schema line that caused it.
    expect(() =>
      foreign(col('items', 'orderId'), col('items', 'sku')).references(
        col('orders', 'id'),
      ),
    ).toThrow(/same count on both sides/)
  })

  test('columns from two different tables are refused', () => {
    expect(() =>
      foreign(col('items', 'orderId'), col('other', 'sku')).references(
        col('orders', 'id'),
        col('orders', 'sku'),
      ),
    ).toThrow(/one table/)
    expect(() =>
      foreign(col('items', 'a'), col('items', 'b')).references(
        col('orders', 'id'),
        col('elsewhere', 'sku'),
      ),
    ).toThrow(/one table/)
  })

  test('no target at all is refused', () => {
    expect(() => foreign(col('items', 'orderId')).references()).toThrow(
      /needs a target/,
    )
  })
})

describe('composite foreign keys against a live server', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
  })

  const DIALECTS: [string, boolean, () => SQLAdapter][] = [
    ['SQLite', false, () => new SQLiteAdapter(':memory:')],
    ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL)],
    ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL)],
  ]

  for (const [name, skip, open] of DIALECTS) {
    test.skipIf(skip)(`${name}: enforces a two-column reference`, async () => {
      const db = open()
      const parent = `bakery_cfk_p_${process.pid}`
      const child = `bakery_cfk_c_${process.pid}`
      cleanup.push(async () => {
        await alive(db.query(`DROP TABLE IF EXISTS ${child}`).run())
        await alive(db.query(`DROP TABLE IF EXISTS ${parent}`).run())
        await db.close?.()
      })
      await alive(db.query(`DROP TABLE IF EXISTS ${child}`).run())
      await alive(db.query(`DROP TABLE IF EXISTS ${parent}`).run())

      // The target of a composite key needs a matching composite unique/primary
      // key, or every dialect refuses the reference.
      await alive(
        db
          .query(
            `CREATE TABLE ${parent} (` +
              `${db.quote('id')} ${db.colDef(Field.Int(), 'id')}, ` +
              `${db.quote('sku')} ${db.colDef(Field.Varchar(32, ''), 'sku')}, ` +
              `PRIMARY KEY (${db.quote('id')}, ${db.quote('sku')}))`,
          )
          .run(),
      )

      const fk: any = foreign(
        col(child, 'orderId'),
        col(child, 'sku'),
      ).references(col(parent, 'id'), col(parent, 'sku'), {
        onDelete: 'CASCADE',
      })

      await alive(
        db
          .query(
            `CREATE TABLE ${child} (` +
              `${db.quote('order_id')} ${db.colDef(Field.Int(), 'orderId')}, ` +
              `${db.quote('sku')} ${db.colDef(Field.Varchar(32, ''), 'sku')},` +
              db.foreignKeyClause(fk) +
              ')',
          )
          .run(),
      )

      await alive(
        db.query(`INSERT INTO ${parent} (${db.quote('id')}, ${db.quote('sku')}) VALUES (?, ?)`).run(1, 'abc'),
      )
      await alive(
        db.query(`INSERT INTO ${child} (${db.quote('order_id')}, ${db.quote('sku')}) VALUES (?, ?)`).run(1, 'abc'),
      )

      // A row matching only *half* the key must be rejected. This is the whole
      // difference between a composite key and two independent ones, and the
      // thing "works by construction" could never establish.
      let rejected = false
      try {
        await alive(
          db.query(`INSERT INTO ${child} (${db.quote('order_id')}, ${db.quote('sku')}) VALUES (?, ?)`).run(1, 'nope'),
        )
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)

      // ON DELETE CASCADE across both columns.
      await alive(db.query(`DELETE FROM ${parent} WHERE ${db.quote('id')} = ?`).run(1))
      const left = (await alive(db.query(`SELECT * FROM ${child}`).all())) as any[]
      expect(left).toHaveLength(0)
    })

    test.skipIf(skip)(`${name}: reads the composite key back`, async () => {
      // Read-back matters as much as creation: a key the adapter cannot report
      // is one the diff will try to add again on every sync.
      const db = open()
      const parent = `bakery_cfkr_p_${process.pid}`
      const child = `bakery_cfkr_c_${process.pid}`
      cleanup.push(async () => {
        await alive(db.query(`DROP TABLE IF EXISTS ${child}`).run())
        await alive(db.query(`DROP TABLE IF EXISTS ${parent}`).run())
        await db.close?.()
      })
      await alive(db.query(`DROP TABLE IF EXISTS ${child}`).run())
      await alive(db.query(`DROP TABLE IF EXISTS ${parent}`).run())
      await alive(
        db
          .query(
            `CREATE TABLE ${parent} (${db.quote('id')} INT, ${db.quote('sku')} VARCHAR(32), PRIMARY KEY (${db.quote('id')}, ${db.quote('sku')}))`,
          )
          .run(),
      )
      const fk: any = foreign(col(child, 'orderId'), col(child, 'sku')).references(
        col(parent, 'id'),
        col(parent, 'sku'),
      )
      await alive(
        db
          .query(
            `CREATE TABLE ${child} (${db.quote('order_id')} INT, ${db.quote('sku')} VARCHAR(32),` +
              db.foreignKeyClause(fk) +
              ')',
          )
          .run(),
      )

      const keys: any = await alive(db.getForeignKeys())
      const mine = Object.values(keys).find(
        (k: any) => k.cols?.length === 2 && String(k.table).toLowerCase().includes('cfkr_c'),
      ) as any
      expect(mine).toBeDefined()
      expect(mine.cols).toHaveLength(2)
      expect(mine.refCols).toHaveLength(2)
      // Order is part of the key's meaning, not an implementation detail.
      expect(mine.cols.map((c: string) => c.toLowerCase())).toEqual([
        'order_id',
        'sku',
      ])
    })
  }
})
