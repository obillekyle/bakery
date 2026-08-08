import { afterAll, describe, expect, test } from 'bun:test'
import { MySQLAdapter } from './adapters/mysql'
import { PGAdapter } from './adapters/pgsql'
import { SQLiteAdapter } from './adapters/sqlite'
import type { SQLAdapter } from './adapters/base'
import { Field } from './field'
import { poolOptionsFromEnv, withPoolOptions } from './pool'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/** See adapters/nested-tx.test.ts — Bun's MySQL driver needs a pending timer. */
function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

describe('Field.Enum', () => {
  test('carries its members and sizes itself to the longest', () => {
    const col: any = Field.Enum(['draft', 'published'] as const, 'draft')
    expect(col.type).toBe('string')
    expect(col.default).toBe('draft')
    expect(col._enum).toEqual(['draft', 'published'])
    // Too small a column would reject a value the CHECK permits.
    expect(col.length).toBe('published'.length)
  })

  test('a nullable enum is nullable', () => {
    const col: any = Field.Enum(['a', 'bb'] as const, null)
    expect(col.nullable).toBe(true)
    expect(col.length).toBe(2)
  })

  test('every dialect emits the same CHECK, MySQL included', () => {
    const def = Field.Enum(['draft', 'published'] as const, 'draft')
    // Deliberately not MySQL's native ENUM: a value rejected on one dialect and
    // accepted on another is an app that behaves differently by deployment.
    for (const db of [
      new SQLiteAdapter(':memory:'),
      new PGAdapter(),
      new MySQLAdapter(),
    ]) {
      const sql = db.colDef(def, 'status')
      expect(sql).toContain('CHECK')
      expect(sql).toContain("'draft'")
      expect(sql).toContain("'published'")
      expect(sql.toUpperCase()).not.toContain('ENUM(')
    }
  })

  test('a member containing a quote cannot break out of the CHECK', () => {
    const def = Field.Enum(["it's", 'ok'] as const)
    const sql = new SQLiteAdapter(':memory:').colDef(def, 'status')
    expect(sql).toContain("'it''s'")
  })

  test('no column name means no CHECK rather than broken SQL', () => {
    // The ALTER path knows the name; anything that does not must still emit a
    // usable column definition.
    const def = Field.Enum(['a', 'b'] as const)
    expect(new SQLiteAdapter(':memory:').colDef(def)).not.toContain('CHECK')
  })
})

describe('Field.Uuid', () => {
  test('is sized text defaulting to the %uuid% marker', () => {
    const col: any = Field.Uuid()
    expect(col.type).toBe('string')
    expect(col.length).toBe(36)
    expect(col.default).toBe('%uuid%')
  })

  test('each dialect emits its own generator', () => {
    expect(new PGAdapter().colDef(Field.Uuid())).toContain('gen_random_uuid()')
    expect(new MySQLAdapter().colDef(Field.Uuid())).toContain('UUID()')
    expect(new SQLiteAdapter(':memory:').colDef(Field.Uuid())).toContain(
      'randomblob',
    )
  })

  test('every dialect reads its own expression back as %uuid%', () => {
    // The half that prevents a perpetual rebuild: without it the database
    // reports its generator, the schema says %uuid%, and they never agree.
    const cases: [SQLAdapter, string][] = [
      [new PGAdapter(), 'gen_random_uuid()'],
      [new MySQLAdapter(), 'uuid()'],
      [new SQLiteAdapter(':memory:'), new SQLiteAdapter(':memory:').uuidExpression],
    ]
    for (const [db, reported] of cases) {
      expect(db.isUuidDefault(reported)).toBe(true)
      // And does not claim everything is a uuid default.
      expect(db.isUuidDefault('hello')).toBe(false)
    }
  })

  test('a nullable uuid has no generator default', () => {
    const col: any = Field.Uuid(true)
    expect(col.nullable).toBe(true)
    expect(col.default).toBeNull()
  })
})

describe('Field.Timestamps and Field.now', () => {
  test('expands to the two columns, both defaulting to insert time', () => {
    const t: any = Field.Timestamps()
    expect(Object.keys(t)).toEqual(['createdAt', 'updatedAt'])
    expect(t.createdAt.default).toBe('%dateNow%')
    expect(t.updatedAt.default).toBe('%dateNow%')
    expect(t.createdAt.type).toBe('integer')
  })

  test('now() is Unix seconds, so it binds as an ordinary parameter', () => {
    const now = Field.now()
    expect(Number.isInteger(now)).toBe(true)
    // Seconds, not milliseconds: a ms value would be ~1000x larger and silently
    // wrong in every comparison against a %dateNow% column.
    expect(Math.abs(now - Date.now() / 1000)).toBeLessThan(5)
  })
})

describe('pool options', () => {
  test('reads the documented env vars', () => {
    expect(
      poolOptionsFromEnv({
        DB_POOL_MAX: '7',
        DB_POOL_IDLE_TIMEOUT: '30',
        DB_POOL_CONNECTION_TIMEOUT: '5',
        DB_POOL_MAX_LIFETIME: '600',
      }),
    ).toEqual({
      max: 7,
      idleTimeout: 30,
      connectionTimeout: 5,
      maxLifetime: 600,
    })
  })

  test('drops what Bun would take and misbehave on', () => {
    // Unset must stay unset — an omitted option is Bun's default, which is not
    // the same as passing it a zero or a NaN.
    expect(poolOptionsFromEnv({ DB_POOL_MAX: 'lots' })).toEqual({})
    expect(poolOptionsFromEnv({ DB_POOL_MAX: '0' })).toEqual({})
    expect(poolOptionsFromEnv({ DB_POOL_MAX: '-1' })).toEqual({})
    expect(poolOptionsFromEnv({ DB_POOL_MAX: '' })).toEqual({})
    expect(poolOptionsFromEnv({})).toEqual({})
  })

  test('forwards only known keys', () => {
    // Bun accepts an unrecognised option silently, so a stray key would
    // configure nothing and report nothing.
    const merged: any = withPoolOptions({ a: 1 }, { max: 3 })
    expect(merged).toEqual({ a: 1, max: 3 })
    expect(poolOptionsFromEnv({ DB_POOL_NONSENSE: '5' } as any)).toEqual({})
  })
})

/**
 * The half that cannot be asserted without a server: does the DDL these
 * builders emit actually execute, and does the default read back as the marker
 * it was written from?
 *
 * A failure of the second is not cosmetic — it is the perpetual-rebuild bug,
 * where the schema and the database disagree forever and every sync rewrites
 * the table.
 */
describe('live round-trip', () => {
  const cleanup: Array<() => Promise<unknown> | unknown> = []
  afterAll(async () => {
    for (const fn of cleanup) await fn()
  })

  const dialects: [string, boolean, () => SQLAdapter][] = [
    ['SQLite', false, () => new SQLiteAdapter(':memory:')],
    ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL)],
    ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL)],
  ]

  for (const [name, skip, open] of dialects) {
    test.skipIf(skip)(`${name}: uuid and enum survive a round trip`, async () => {
      const db = open()
      const table = `bakery_field_${process.pid}`
      cleanup.push(async () => {
        await alive(db.query(`DROP TABLE IF EXISTS ${table}`).run())
        await db.close?.()
      })
      await alive(db.query(`DROP TABLE IF EXISTS ${table}`).run())

      const cols = {
        id: Field.Uuid(),
        status: Field.Enum(['draft', 'published'] as const, 'draft'),
      }
      const ddl = Object.entries(cols)
        .map(([n, d]) => `${db.quote(n)} ${db.colDef(d, n)}`)
        .join(', ')
      await alive(db.query(`CREATE TABLE ${table} (${ddl})`).run())

      // The database fills both in.
      await alive(db.query(`INSERT INTO ${table} (${db.quote('status')}) VALUES (?)`).run('published'))
      const rows = (await alive(
        db.query(`SELECT ${db.quote('id')}, ${db.quote('status')} FROM ${table}`).all(),
      )) as any[]
      expect(rows).toHaveLength(1)
      expect(String(rows[0].id)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      expect(rows[0].status).toBe('published')

      // The CHECK is real on every dialect, not just the one with native ENUM.
      let rejected = false
      try {
        await alive(db.query(`INSERT INTO ${table} (${db.quote('status')}) VALUES (?)`).run('bogus'))
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)

      // And the default reads back as the marker it was written from — this is
      // the assertion that stands between here and a table rebuilt forever.
      const constraints: any = await alive(db.getConstraints())
      const key = Object.keys(constraints).find(
        k => k.toLowerCase().replace(/_/g, '') === table.toLowerCase().replace(/_/g, ''),
      )
      expect(key).toBeDefined()
      expect(constraints[key!].id.default).toBe('%uuid%')

      // The decisive one. A column that differs from itself is not a cosmetic
      // problem: it makes every sync rebuild the table, forever. `length` and
      // `_enum` are excluded from the diff precisely so this holds, and this is
      // the assertion that proves the exclusion works against a real server
      // rather than against the object we just built.
      // The whole introspected set, not just our table: `buildSyncPlan` diffs
      // the entire database, so handing it one table makes every *other* table
      // look unmapped and it stops to ask what to drop.
      //
      // Feeding it exactly what it just read is the self-comparison that
      // matters — if a column differs from itself, it lands in `tablesToRebuild`
      // and every sync from here to eternity rewrites the table.
      const { buildSyncPlan } = await import('./sync/helpers')
      const { Logger, messageLogger } = await import('@bakery/core/logger')
      const quiet = new Logger('field-test')
      const plan = await alive(
        buildSyncPlan(db, constraints, quiet, messageLogger(quiet, {} as any)),
      )
      expect([...plan.tablesToRebuild]).toEqual([])
      expect(plan.columnsToAdd).toEqual([])
      expect(plan.columnsToDrop).toEqual([])
    })
  }
})
