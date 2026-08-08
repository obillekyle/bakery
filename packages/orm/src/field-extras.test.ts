import { afterAll, describe, expect, test } from 'bun:test'
import { MySQLAdapter } from './adapters/mysql'
import { PGAdapter } from './adapters/pgsql'
import { SQLiteAdapter } from './adapters/sqlite'
import type { SQLAdapter } from './adapters/base'
import { Field } from './field'
import { poolOptionsFromEnv, withPoolOptions } from './pool'
import type { ExtractOptionals, ExtractTableTypes } from './schema-util'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/** See adapters/nested-tx.test.ts — Bun's MySQL driver needs a pending timer. */
function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

/**
 * Type-level assertions, checked by `bun run typecheck` rather than at runtime.
 *
 * `Field.Foreign` used to return `as any`, so every foreign-key column inferred
 * as `any` and nothing noticed — a row type that silently gives up is worse than
 * one that is wrong, because nothing downstream complains. These fail to
 * *compile* if that regresses.
 */
type Expect<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const TYPED = {
  users: { id: Field.Primary(), name: Field.Varchar(64, '') },
  posts: {
    id: Field.Primary(),
    authorId: Field.Foreign({ __table: 'users', __column: 'id' }),
    editorId: Field.Foreign(
      { __table: 'users', __column: 'id' },
      { nullable: true },
    ),
    status: Field.Enum(['draft', 'published'] as const, 'draft'),
  },
}
type C = typeof TYPED
type PostRow = ExtractTableTypes<C, 'posts'>

// Primary is always integer, so always `number`.
const _primaryIsNumber: Expect<PostRow['id'], number> = true
// Foreign is always integer, so always `number` …
const _foreignIsNumber: Expect<PostRow['authorId'], number> = true
// … and `number | null` when nullable. Not `any`, which is what it used to be.
const _nullableForeign: Expect<PostRow['editorId'], number | null> = true
// Enum contributes its union, not `string`.
const _enumIsUnion: Expect<PostRow['status'], 'draft' | 'published'> = true
// Nullable and defaulted columns are optional on insert; a plain key is not.
type Opt = ExtractOptionals<C, 'posts'>
// Checked per key rather than as one union: a union mismatch reports only
// 'true is not assignable to never', which says nothing about which key moved.
const _optId: Expect<Extract<Opt, 'id'>, 'id'> = true
const _optEditor: Expect<Extract<Opt, 'editorId'>, 'editorId'> = true
const _optStatus: Expect<Extract<Opt, 'status'>, 'status'> = true
// authorId is required on insert: no default, not nullable.
const _reqAuthor: Expect<Extract<Opt, 'authorId'>, never> = true
void [
  _primaryIsNumber,
  _foreignIsNumber,
  _nullableForeign,
  _enumIsUnion,
  _optId,
  _optEditor,
  _optStatus,
  _reqAuthor,
]

describe('Field.Primary and Field.Foreign are integer', () => {
  test('Primary is an auto-increment integer key', () => {
    expect(Field.Primary()).toEqual({
      type: 'integer',
      autoIncrement: true,
      primary: true,
    } as any)
  })

  test('Foreign is an integer carrying its reference', () => {
    const fk: any = Field.Foreign({ __table: 'users', __column: 'id' })
    expect(fk.type).toBe('integer')
    expect(fk.nullable).toBeUndefined()
    expect(fk._references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined,
    })
  })

  test('a nullable Foreign is integer-or-null', () => {
    const fk: any = Field.Foreign(
      { __table: 'users', __column: 'id' },
      { nullable: true, onDelete: 'SET NULL' },
    )
    expect(fk.type).toBe('integer')
    expect(fk.nullable).toBe(true)
    expect(fk.default).toBeNull()
    expect(fk._references.onDelete).toBe('SET NULL')
  })
})

describe('Field.Index and Field.Unique', () => {
  const col = (table: string, column: string) =>
    ({ __table: table, __column: column }) as any

  test('carry their own table, so there is no table argument to mistype', () => {
    expect(Field.Index(col('posts', 'authorId'))).toEqual({
      type: 'index',
      table: 'posts',
      cols: ['authorId'],
    })
    expect(Field.Unique(col('users', 'email'))).toEqual({
      type: 'unique',
      table: 'users',
      cols: ['email'],
    })
  })

  test('several columns make one composite declaration, in order', () => {
    // Order is what decides which queries an index can serve, so it is part of
    // the declaration rather than an implementation detail.
    expect(Field.Index(col('posts', 'authorId'), col('posts', 'createdAt'))).toEqual(
      { type: 'index', table: 'posts', cols: ['authorId', 'createdAt'] },
    )
  })
})

/** A real TypeScript string enum, which is what most schemas already have. */
enum Status {
  Draft = 'draft',
  Published = 'published',
}
/** Numeric enums reverse-map, which is why they are refused. */
enum Priority {
  Low,
  High,
}

// The enum form must infer the enum's own union, not `string`.
const ENUM_TYPED = { posts: { status: Field.Enum(Status, Status.Draft) } }
const _enumFromTsEnum: Expect<
  ExtractTableTypes<typeof ENUM_TYPED, 'posts'>['status'],
  Status
> = true
void _enumFromTsEnum

describe('Field.Enum accepts a TypeScript enum', () => {
  test('takes a string enum and reads its values', () => {
    const col: any = Field.Enum(Status, Status.Draft)
    expect(col._enum).toEqual(['draft', 'published'])
    expect(col.default).toBe('draft')
    expect(col.length).toBe('published'.length)
  })

  test('produces the same column as the equivalent array', () => {
    // The two spellings must not drift — one is sugar for the other.
    const fromEnum: any = Field.Enum(Status, Status.Draft)
    const fromArray: any = Field.Enum(['draft', 'published'] as const, 'draft')
    expect(fromEnum).toEqual(fromArray)
  })

  test('the CHECK is built from the enum values, not its names', () => {
    const sql = new SQLiteAdapter(':memory:').colDef(
      Field.Enum(Status, Status.Draft),
      'status',
    )
    expect(sql).toContain("'draft'")
    expect(sql).toContain("'published'")
    // 'Draft'/'Published' are the member *names* and mean nothing to the column.
    expect(sql).not.toContain("'Draft'")
  })

  test('a numeric enum is refused, by name, rather than half-stored', () => {
    // Object.values(Priority) is ['Low','High',0,1] — a CHECK built from that
    // would permit the member names and reject the values actually stored.
    expect(() => Field.Enum(Priority as any)).toThrow(/numeric enum/)
  })

  test('an empty enum is refused', () => {
    expect(() => Field.Enum([] as any)).toThrow(/at least one member/)
  })
})

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
