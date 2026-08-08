import { describe, expect, test } from 'bun:test'
import { MySQLAdapter } from './adapters/mysql'
import { PGAdapter } from './adapters/pgsql'
import { SQLiteAdapter } from './adapters/sqlite'
import {
  collectConstraints,
  type InferViews,
  type InsertOf,
  type RowOf,
  table,
  view,
} from './define'
import { Field } from './field'
import type { ExtractTableTypes } from './schema-util'

/**
 * Views.
 *
 * They worked before this — `_view` inside a table's constraints has always
 * been created with `CREATE VIEW` — but only the older `DBInfo` layout could
 * *declare* one. In the `orm/` folder layout, which the docs call preferred, it
 * meant writing `_view` into a `table()` call and casting through `any`.
 * `view()` types what was already there.
 */

const users = table('users', {
  id: Field.Primary(),
  name: Field.Varchar(64),
  active: Field.Int(0),
})

const activeUsers = view(
  'active_users',
  'SELECT id, name FROM users WHERE active = 1',
  { id: Field.Primary(), name: Field.Varchar(64) },
)

describe('view() declaration', () => {
  test('carries the SELECT body where the sync engine looks for it', () => {
    expect(activeUsers.__table).toBe('active_users')
    expect((activeUsers.__columns as any)._view).toBe(
      'SELECT id, name FROM users WHERE active = 1',
    )
  })

  test('columns are still column references, so joins and indexes work', () => {
    expect(activeUsers.id).toEqual({
      __table: 'active_users',
      __column: 'id',
    } as any)
  })

  test('collectConstraints picks it up alongside tables', () => {
    const c: any = collectConstraints({ users, activeUsers })
    expect(Object.keys(c).sort()).toEqual(['active_users', 'users'])
    expect(c.active_users._view).toContain('SELECT id, name FROM users')
  })
})

/**
 * Type-level. `_view` must not become a column in the row type, and the view's
 * name must reach `InferViews` — that is what stops a write to it compiling.
 */
type Expect<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const MODEL = { users, activeUsers }
type C = { active_users: (typeof activeUsers)['__columns'] }
type ViewRow = ExtractTableTypes<C, 'active_users'>

// `_view` is metadata, not a column: it must not appear in the row type.
const _noViewKey: Expect<keyof ViewRow, 'id' | 'name'> = true
// …and the columns are typed exactly as a table's are.
const _viewRowTyped: Expect<ViewRow['name'], string> = true
// The name reaches InferViews, which is what Mutation.Tables excludes.
const _isView: Expect<Extract<InferViews<typeof MODEL>, 'active_users'>, 'active_users'> = true
// A real table is not a view.
const _notView: Expect<Extract<InferViews<typeof MODEL>, 'users'>, never> = true

/**
 * What `Mutation.Tables` computes, mimicked locally.
 *
 * The real type reads the *registered* schema, and registration is a global
 * `declare module` — two in one program collide, so a test file cannot register
 * one without retyping every other test in the package. The rule itself is what
 * matters and it is reproduced exactly here.
 *
 * End-to-end rejection was verified against a registered schema: with `Views`
 * wired, `DB.Insert.into('active_users')`, `DB.Update.table('active_users')`,
 * `DB.Delete.from('active_users')` and a typo'd `into('userz')` all fail to
 * compile, while `into('users')` still passes.
 */
type MockTables = Exclude<keyof { users: 1; active_users: 1 }, InferViews<typeof MODEL>>
const _viewNotWritable: Expect<Extract<MockTables, 'active_users'>, never> = true
const _tableWritable: Expect<Extract<MockTables, 'users'>, 'users'> = true

void [
  _noViewKey,
  _viewRowTyped,
  _isView,
  _notView,
  _viewNotWritable,
  _tableWritable,
]

describe('a view reaches the database as a view', () => {
  test('CREATE VIEW, not CREATE TABLE, and it is queryable', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)').run()
    await db.query('INSERT INTO users (name, active) VALUES (?, ?)').run('ada', 1)
    await db.query('INSERT INTO users (name, active) VALUES (?, ?)').run('bob', 0)

    // The DDL path the sync engine uses for a `_view` entry.
    await db.query(
      `CREATE VIEW active_users AS ${(activeUsers.__columns as any)._view}`,
    ).run()

    const objs = (await db
      .query("SELECT name, type FROM sqlite_master WHERE name = 'active_users'")
      .all()) as any[]
    expect(objs[0]?.type).toBe('view')

    // It returns only what the SELECT selects — the point of declaring one.
    const rows = (await db.query('SELECT * FROM active_users').all()) as any[]
    expect(rows.map(r => r.name)).toEqual(['ada'])
    await db.close()
  })
})

describe('view() borrowing a source table', () => {
  const src = table('users', {
    id: Field.Primary(),
    name: Field.Varchar(64),
    active: Field.Int(0),
  })
  const derived = view('active_users2', src, 'SELECT * FROM users WHERE active = 1')

  test('takes the source table columns without restating them', () => {
    const cols = derived.__columns as any
    expect(Object.keys(cols).sort()).toEqual(['_view', 'active', 'id', 'name'])
    expect(cols._view).toBe('SELECT * FROM users WHERE active = 1')
  })

  test('columns qualify against the view, not the source table', () => {
    // Otherwise a join against the view would emit `users`.`id`.
    expect(derived.id).toEqual({ __table: 'active_users2', __column: 'id' } as any)
  })

  test('the explicit and borrowed forms agree', () => {
    const explicit = view('active_users2', 'SELECT * FROM users WHERE active = 1', {
      id: Field.Primary(),
      name: Field.Varchar(64),
      active: Field.Int(0),
    })
    expect(derived.__columns).toEqual(explicit.__columns as any)
  })
})

describe('RowOf / InsertOf name a declaration without copying it', () => {
  const users = table('users', {
    id: Field.Primary(),
    name: Field.Varchar(64),
    createdAt: Field.Date.now(),
  })
  const v = view('active_users3', users, 'SELECT * FROM users')

  // Derived, so it cannot drift from the declaration the way a hand-written
  // `interface ActiveUsersView { … }` would.
  type ActiveUsersView = RowOf<typeof v>
  type NewUser = InsertOf<typeof users>

  const _row: Expect<
    ActiveUsersView,
    { id: number; name: string; createdAt: number }
  > = true
  // `name` is required; the auto-increment key and the defaulted timestamp are
  // not, which is what `optional` on the descriptor now states outright.
  const _ins: Expect<
    NewUser,
    { name: string } & { id?: number; createdAt?: number }
  > = true

  test('the row type carries no view metadata', () => {
    void [_row, _ins]
    expect(Object.keys(v.__columns as any)).toContain('_view')
    // …but `_view` is filtered out of the row type — asserted above at compile
    // time; this only pins that the runtime key is genuinely there to filter.
    expect(true).toBe(true)
  })
})

/**
 * A schema containing a view must reach a steady state.
 *
 * Three separate defects made that impossible, and none was visible until
 * `apps/example` moved to the folder layout and grew a real view — all three
 * need a view *and* a live sync to appear:
 *
 * 1. A view was counted as an unmapped TS table forever. `initDbTablesMap`
 *    skips `_view` entries, so a view is never on the database side of the
 *    comparison, and `evaluateChanges` counts `unmappedTsTables` — so the run
 *    reported changes on every sync while printing an empty plan.
 * 2. `view(name, sourceTable, body)` borrows the source's columns, `_references`
 *    included, so the view was given a foreign key of its own. No dialect will
 *    create one on a view, so it was re-planned every sync.
 * 3. Rebuilding a table dropped its foreign keys. A constraint is part of the
 *    table definition and `processTableRebuild` emitted columns only — while
 *    the planner deliberately turns a foreign-key change into a rebuild on
 *    SQLite, which cannot ALTER one in. The plan could never add a key.
 */
describe('a schema with a view settles', () => {
  async function fixture() {
    const db = new SQLiteAdapter(':memory:')
    const users = table('users', { id: Field.Primary(), name: Field.Varchar(64) })
    const posts = table('posts', {
      id: Field.Primary(),
      authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
    })
    const published = view('publishedPosts', posts, 'SELECT * FROM posts')
    const { resolveColumnForeignKeys } = await import('./sync/load')
    const resolved = resolveColumnForeignKeys(
      collectConstraints({ users, posts, published }) as any,
      {} as any,
    )
    return { db, ...resolved }
  }

  test('the view is not counted as a table waiting to be created', async () => {
    const { db, constraints } = await fixture()
    const { buildSyncPlan } = await import('./sync/helpers')
    const quiet: any = { log() {}, confirm: () => false, selectIndex: () => 0 }
    const msgs: any = new Proxy({}, { get: () => () => {} })
    const plan = await buildSyncPlan(db as any, constraints, quiet, msgs)
    expect([...plan.unmappedTsTables]).not.toContain('publishedPosts')
    await db.close()
  })

  test('a view is never given a foreign key of its own', async () => {
    const { db, indexes } = await fixture()
    // `posts.authorId` carries `_references`, and the view borrowed it.
    const forView = Object.values(indexes as any).filter(
      (i: any) => i.type === 'foreign' && /published/i.test(i.table),
    )
    expect(forView).toEqual([])
    // …while the real table still gets one.
    const forPosts = Object.values(indexes as any).filter(
      (i: any) => i.type === 'foreign' && i.table === 'posts',
    )
    expect(forPosts).toHaveLength(1)
    await db.close()
  })

  test('rebuilding a table keeps its foreign keys', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY)').run()
    // Built without the key, exactly as a pre-foreign-key database would be.
    await db
      .query('CREATE TABLE posts (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL)')
      .run()

    const users = table('users', { id: Field.Primary() })
    const posts = table('posts', {
      id: Field.Primary(),
      authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
    })
    const { resolveColumnForeignKeys } = await import('./sync/load')
    const { constraints, indexes } = resolveColumnForeignKeys(
      collectConstraints({ users, posts }) as any,
      {} as any,
    )

    // `executeSyncPlan` rather than `syncSchema`: the plan is the unit under
    // test, and the full path additionally wants a backup, which wants config.
    const { collectForeignKeys, executeSyncPlan } = await import('./sync/helpers')
    const msgs: any = new Proxy({}, { get: () => () => {} })
    const plan: any = {
      tablesToDrop: [], tablesToRename: [], columnsToDrop: [], columnsToAdd: [],
      columnsToRename: [], tablesToRebuild: new Set(['posts']), viewsToUpdate: [],
      unmappedTsTables: new Set(), dbConstraintsForDiff: {},
    }
    await db.transaction(tx =>
      executeSyncPlan(
        tx, plan, constraints, new Set(), new Map(), msgs,
        collectForeignKeys(indexes as any), new Map(), new Map(),
      ),
    )

    const fks = (await db.query('PRAGMA foreign_key_list(posts)').all()) as any[]
    expect(fks.map(f => `${f.from}->${f.table}.${f.to}`)).toEqual([
      'author_id->users.id',
    ])
    await db.close()
  })
})

/**
 * The view lifecycle.
 *
 * Views were invisible to the planner: `initDbTablesMap` skips `_view` entries
 * and every comparison walked that map, so nothing about a view ever reached
 * `hasChanges`. A new view was never planned, an edited `SELECT` was never
 * detected — you could not change a view — and one the schema had dropped was
 * never removed. They stayed roughly correct only because
 * `syncViewsAndTablesPhase` recreates every declared view whenever a sync runs
 * for some *other* reason.
 */
describe('the view lifecycle is planned', () => {
  const BODY = 'SELECT id, name FROM vl_users WHERE active = 1'
  const quiet: any = { log() {}, confirm: () => false, selectIndex: () => 0 }
  const msgs: any = new Proxy({}, { get: () => () => {} })

  async function fixture(withView: boolean) {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE vl_users (id INT, name TEXT, active INT)').run()
    if (withView) await db.createView('vl_active', BODY)
    const live: any = await db.getConstraints()
    const tk = Object.keys(live).find(k => /vlUsers/i.test(k))!
    const vk = Object.keys(live).find(k => /vlActive/i.test(k))
    return { db, live, tk, vk }
  }

  async function plan(db: any, constraints: any) {
    const { buildSyncPlan } = await import('./sync/helpers')
    return buildSyncPlan(db, constraints, quiet, msgs)
  }

  test('an unchanged view is not touched', async () => {
    const { db, live, tk, vk } = await fixture(true)
    const p = await plan(db, { [tk]: live[tk], [vk!]: { ...live[vk!], _view: BODY } })
    expect(p.viewsToUpdate).toEqual([])
    expect(p.tablesToDrop).toEqual([])
    await db.close()
  })

  test('an edited SELECT is detected', async () => {
    // Without this you simply cannot change a view: the schema said one thing,
    // the database another, and `db:sync` reported it perfectly synced.
    const { db, live, tk, vk } = await fixture(true)
    const p = await plan(db, {
      [tk]: live[tk],
      [vk!]: { ...live[vk!], _view: 'SELECT id, name FROM vl_users WHERE active = 0' },
    })
    expect(p.viewsToUpdate).toEqual(['vl_active'])
    await db.close()
  })

  test('a new view is planned even when nothing else changed', async () => {
    // Excluding views from `unmappedTsTables` stopped them being counted as
    // tables waiting to be created — which also removed the only signal that a
    // new one needed creating. This is the replacement.
    const { db, live, tk } = await fixture(false)
    const p = await plan(db, {
      [tk]: live[tk],
      vlActive: { _view: BODY, id: { type: 'integer' } },
    })
    expect(p.viewsToUpdate).toEqual(['vl_active'])
    await db.close()
  })

  test('a view the schema no longer declares is dropped', async () => {
    const { db, live, tk } = await fixture(true)
    const p = await plan(db, { [tk]: live[tk] })
    expect(p.tablesToDrop).toEqual(['vl_active'])
    await db.close()
  })

  test('recreating a view is a change, but not a destructive one', async () => {
    // A view holds no data and `createView` drops and recreates in one step, so
    // counting it as destructive made a schema with a view demand --force-sync
    // in production for nothing.
    const { SyncEngine } = await import('./sync/engine')
    const evaluate = (SyncEngine as any).evaluateChanges
    const base = {
      tablesToDrop: [], tablesToRename: [], columnsToDrop: [], columnsToAdd: [],
      columnsToRename: [], tablesToRebuild: new Set(), unmappedTsTables: new Set(),
    }
    const r = evaluate({ ...base, viewsToUpdate: ['v'] }, new Set(), new Map())
    expect(r).toEqual({ isDangerous: false, hasChanges: true })
    // Dropping one still is: that is `tablesToDrop`.
    const d = evaluate({ ...base, tablesToDrop: ['v'], viewsToUpdate: [] }, new Set(), new Map())
    expect(d.isDangerous).toBe(true)
  })
})

/**
 * What a stored view body looks like coming back, per dialect.
 *
 * SQLite keeps the text verbatim. MySQL re-qualifies every column and adds
 * parentheses; Postgres adds parentheses and a trailing semicolon. So an
 * *authored* `SELECT` and the server's rendering of it are different strings,
 * and no amount of text normalisation short of a SQL parser closes that.
 *
 * The ledger is what makes it converge, and that is precisely what the ledger
 * is for — it records what was *applied*, so the next run compares the authored
 * body against the authored body. Falling back to live introspection costs one
 * view recreate per sync on MySQL and Postgres, which is why recreating a view
 * is no longer treated as destructive.
 */
describe('view bodies across dialects', () => {
  const MYSQL_URL = process.env.MYSQL_TEST_URL
  const PGSQL_URL = process.env.PGSQL_TEST_URL
  const BODY = 'SELECT id, name FROM vd_users WHERE active = 1'
  const quiet: any = { log() {}, confirm: () => false, selectIndex: () => 0 }
  const msgs: any = new Proxy({}, { get: () => () => {} })

  const DIALECTS: [string, boolean, () => any, boolean][] = [
    ['SQLite', false, () => new SQLiteAdapter(':memory:'), true],
    ['MySQL', !MYSQL_URL, () => new MySQLAdapter(MYSQL_URL), false],
    ['Postgres', !PGSQL_URL, () => new PGAdapter(PGSQL_URL), false],
  ]

  for (const [name, skip, open, verbatim] of DIALECTS) {
    test.skipIf(skip)(`${name}: stable once the ledger records it`, async () => {
      const db = open()
      const alive = <T,>(p: T | Promise<T>) => {
        const t = setTimeout(() => {}, 30_000)
        return Promise.resolve(p).finally(() => clearTimeout(t))
      }
      for (const s of [
        'DROP VIEW IF EXISTS vd_active',
        'DROP TABLE IF EXISTS vd_users',
        'DROP TABLE IF EXISTS __bakery_schema',
      ]) await alive(db.query(s).run())
      await alive(db.query('CREATE TABLE vd_users (id INT, name VARCHAR(64), active INT)').run())
      await alive(db.createView('vd_active', BODY))

      const { buildSyncPlan } = await import('./sync/helpers')
      const { writeLedger } = await import('./sync/ledger')
      const live: any = await alive(db.getConstraints())
      const tk = Object.keys(live).find(k => /vdUsers|vd_users/i.test(k))!
      const vk = Object.keys(live).find(k => /vdActive|vd_active/i.test(k))!
      const schema: any = { [tk]: live[tk], [vk]: { ...live[vk], _view: BODY } }

      // Against live introspection: only a dialect that stores the body
      // verbatim can match an authored SELECT.
      const first = await alive(buildSyncPlan(db, schema, quiet, msgs))
      expect({ dialect: name, changed: first.viewsToUpdate.length > 0 }).toEqual({
        dialect: name,
        changed: !verbatim,
      })

      // Against the ledger — the normal path — every dialect is stable.
      await alive(writeLedger(db, schema, {}))
      const second = await alive(buildSyncPlan(db, schema, quiet, msgs))
      expect({ dialect: name, source: second.ledgerSource, changed: second.viewsToUpdate }).toEqual(
        { dialect: name, source: 'ledger', changed: [] },
      )

      for (const s of [
        'DROP VIEW IF EXISTS vd_active',
        'DROP TABLE IF EXISTS vd_users',
        'DROP TABLE IF EXISTS __bakery_schema',
      ]) await alive(db.query(s).run())
      await db.close?.()
    })
  }
})
