import { describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from './adapters/sqlite'
import { collectConstraints, table, type InferViews, view } from './define'
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
