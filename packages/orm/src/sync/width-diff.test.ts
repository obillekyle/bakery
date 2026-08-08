import { afterAll, describe, expect, test } from 'bun:test'
import type { SQLAdapter } from '../adapters/base'
import { MySQLAdapter } from '../adapters/mysql'
import { PGAdapter } from '../adapters/pgsql'
import { SQLiteAdapter } from '../adapters/sqlite'
import { Field } from '../field'
import { buildSyncPlan } from './helpers'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/** See adapters/nested-tx.test.ts — Bun's MySQL driver needs a pending timer. */
function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

const quiet = () => {
  const logger: any = { log: () => {}, confirm: () => false }
  const messages: any = new Proxy({}, { get: () => () => {} })
  return { logger, messages }
}

const DIALECTS: [string, boolean, () => SQLAdapter][] = [
  ['SQLite', false, () => new SQLiteAdapter(':memory:')],
  ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL)],
  ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL)],
]

/**
 * `VARCHAR` width in the column diff.
 *
 * This was deliberately excluded for months, and the reason was good: it needs
 * every adapter to report the width back *exactly*, and one that did not would
 * rebuild the table on every sync forever. What changed is that all three could
 * finally be measured against live servers rather than trusted.
 *
 * The measurement found the trap immediately — MySQL reports
 * `character_maximum_length = 65535` for an unsized `TEXT` where Postgres
 * reports `null`, so a naive read makes every `Field.Text()` column rebuild on
 * MySQL and only on MySQL. That is what the third test here pins.
 */
describe('sizedTextLength guard', () => {
  const db = new SQLiteAdapter(':memory:') as any

  test('takes a width only from a sized text type', () => {
    expect(db.sizedTextLength('varchar(64)', 64)).toBe(64)
    expect(db.sizedTextLength('character varying', 255)).toBe(255)
    expect(db.sizedTextLength('CHAR(36)', 36)).toBe(36)
  })

  test('refuses the width MySQL reports for unsized TEXT', () => {
    // The whole reason the guard exists.
    expect(db.sizedTextLength('text', 65535)).toBeUndefined()
    expect(db.sizedTextLength('mediumtext', 16777215)).toBeUndefined()
    expect(db.sizedTextLength('int', null)).toBeUndefined()
  })

  test('refuses a width that is not a usable number', () => {
    expect(db.sizedTextLength('varchar', null)).toBeUndefined()
    expect(db.sizedTextLength('varchar', 'lots')).toBeUndefined()
    expect(db.sizedTextLength('varchar', 0)).toBeUndefined()
  })
})

describe('width participates in the column diff', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
  })

  async function fixture(dialect: () => SQLAdapter, suffix: string) {
    const db = dialect()
    const table = `bakery_width_${suffix}_${process.pid}`
    cleanup.push(async () => {
      await alive(db.query(`DROP TABLE IF EXISTS ${table}`).run())
      await db.close?.()
    })
    await alive(db.query(`DROP TABLE IF EXISTS ${table}`).run())
    return { db, table }
  }

  /**
   * Plan the whole database against itself, with one table's schema swapped for
   * `tsTable`. Feeding `buildSyncPlan` the full introspected set is what keeps
   * every *other* table mapped — hand it one table and it stops to ask what to
   * drop.
   */
  async function planFor(db: SQLAdapter, table: string, tsTable: any) {
    const live: any = await alive(db.getConstraints())
    const key = Object.keys(live).find(
      k =>
        k.toLowerCase().replace(/_/g, '') ===
        table.toLowerCase().replace(/_/g, ''),
    )!
    const { logger, messages } = quiet()
    const plan = await alive(
      buildSyncPlan(db, { ...live, [key]: tsTable }, logger, messages),
    )
    return { plan, key, live }
  }

  for (const [name, skip, open] of DIALECTS) {
    test.skipIf(skip)(`${name}: a widened Varchar is a rebuild`, async () => {
      const { db, table } = await fixture(open, 'grow')
      const cols = { id: Field.Primary(), slug: Field.Varchar(64, '') }
      const ddl = Object.entries(cols)
        .map(([n, d]) => `${db.quote(n)} ${db.colDef(d, n)}`)
        .join(', ')
      await alive(db.query(`CREATE TABLE ${table} (${ddl})`).run())

      // Same schema: nothing to do. If this fails the feature is worse than
      // useless — it rebuilds on every sync.
      const same = await planFor(db, table, {
        id: Field.Primary(),
        slug: Field.Varchar(64, ''),
      })
      expect([...same.plan.tablesToRebuild]).toEqual([])

      // The database reports the width it was given.
      expect(same.live[same.key].slug.length).toBe(64)

      // Widened: this is the change that used to do nothing at all.
      const wider = await planFor(db, table, {
        id: Field.Primary(),
        slug: Field.Varchar(128, ''),
      })
      expect([...wider.plan.tablesToRebuild]).toHaveLength(1)
    })

    test.skipIf(skip)(
      `${name}: an unsized text column does not rebuild`,
      async () => {
        // MySQL's 65535 lands here. Before the guard this test failed on MySQL
        // and passed everywhere else, which is the worst shape a bug can have.
        const { db, table } = await fixture(open, 'text')
        const cols = { id: Field.Primary(), body: Field.Text() }
        const ddl = Object.entries(cols)
          .map(([n, d]) => `${db.quote(n)} ${db.colDef(d, n)}`)
          .join(', ')
        await alive(db.query(`CREATE TABLE ${table} (${ddl})`).run())

        const { plan, live, key } = await planFor(db, table, {
          id: Field.Primary(),
          body: Field.Text(),
        })
        expect(live[key].body.length).toBeUndefined()
        expect([...plan.tablesToRebuild]).toEqual([])
      },
    )

    test.skipIf(skip)(
      `${name}: an unsized schema column does not shrink a sized one`,
      async () => {
        // Declaring Text() against an existing VARCHAR is not a request to
        // rebuild; only a width that disagrees with another width is.
        const { db, table } = await fixture(open, 'unsized')
        const cols = { id: Field.Primary(), slug: Field.Varchar(64, '') }
        const ddl = Object.entries(cols)
          .map(([n, d]) => `${db.quote(n)} ${db.colDef(d, n)}`)
          .join(', ')
        await alive(db.query(`CREATE TABLE ${table} (${ddl})`).run())

        const { plan } = await planFor(db, table, {
          id: Field.Primary(),
          // Same type and default, no width.
          slug: { type: 'string', default: '' },
        })
        expect([...plan.tablesToRebuild]).toEqual([])
      },
    )
  }
})
