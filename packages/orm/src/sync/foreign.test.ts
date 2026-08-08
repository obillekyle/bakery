import { describe, expect, test } from 'bun:test'
import { SQLAdapter } from '../adapters/base'
import { SQLiteAdapter } from '../adapters/sqlite'
import {
  calculateForeignKeyDiff,
  collectForeignKeys,
  orderTablesByDependency,
} from './helpers'

const FK = {
  posts_author: {
    type: 'foreign' as const,
    table: 'posts',
    cols: ['authorId'],
    refTable: 'users',
    refCols: ['id'],
  },
}

describe('foreign key identity', () => {
  test('is the tuple, never the constraint name', () => {
    // SQLite's `PRAGMA foreign_key_list` reports no name at all, so a
    // name-keyed diff would see every SQLite foreign key as new on every sync.
    // The same key declared with and without a name must collide.
    const named = { table: 'posts', cols: ['authorId'], refTable: 'users', refCols: ['id'], name: 'whatever' }
    const anon = { table: 'posts', cols: ['authorId'], refTable: 'users', refCols: ['id'] }
    expect(SQLAdapter.foreignKeyId(named)).toBe(SQLAdapter.foreignKeyId(anon))
  })

  test('snake-cases both sides, so declaration style does not matter', () => {
    expect(
      SQLAdapter.foreignKeyId({ table: 'blogPosts', cols: ['authorId'], refTable: 'appUsers', refCols: ['id'] }),
    ).toBe(
      SQLAdapter.foreignKeyId({ table: 'blog_posts', cols: ['author_id'], refTable: 'app_users', refCols: ['id'] }),
    )
  })
})

describe('collect and diff', () => {
  test('picks foreign() out of the declaration map', () => {
    const fks = collectForeignKeys({ ...FK, byAuthor: { type: 'index', table: 'posts', cols: ['authorId'] } } as any)
    expect(Object.keys(fks)).toEqual(['posts->author_id->users->id'])
  })

  test('a key already in the database is not re-added', () => {
    const ts = collectForeignKeys(FK as any)
    const { fksToAdd, fksToDrop } = calculateForeignKeyDiff(ts, ts, new Set())
    expect(fksToAdd.size).toBe(0)
    expect(fksToDrop.size).toBe(0)
  })

  test('a key only in the database is dropped, only in the schema is added', () => {
    const ts = collectForeignKeys(FK as any)
    expect(calculateForeignKeyDiff({}, ts, new Set()).fksToAdd.size).toBe(1)
    expect(calculateForeignKeyDiff(ts, {}, new Set()).fksToDrop.size).toBe(1)
  })

  test('a rebuilt table is left alone', () => {
    // A rebuild recreates the table from the constraints with its foreign keys
    // inline, so adding one separately would duplicate the constraint.
    const ts = collectForeignKeys(FK as any)
    const { fksToAdd } = calculateForeignKeyDiff({}, ts, new Set(['posts']))
    expect(fksToAdd.size).toBe(0)
  })
})

describe('table ordering', () => {
  test('parents come before children regardless of declaration order', () => {
    // Not cosmetic: a foreign key needs the referenced table to exist, and
    // Postgres answers `relation "users" does not exist` otherwise.
    const ts = collectForeignKeys(FK as any)
    expect(orderTablesByDependency(['posts', 'users'], ts)).toEqual(['users', 'posts'])
    expect(orderTablesByDependency(['users', 'posts'], ts)).toEqual(['users', 'posts'])
  })

  test('a self-reference does not deadlock the sort', () => {
    const selfRef = collectForeignKeys({
      t_parent: { type: 'foreign', table: 't', cols: ['parentId'], refTable: 't', refCols: ['id'] },
    } as any)
    expect(orderTablesByDependency(['t'], selfRef)).toEqual(['t'])
  })

  test('a cycle still returns every table rather than looping', () => {
    // Unorderable by definition. Emitting them all lets the database refuse the
    // key that closes the cycle, which is a clearer failure than a hang or a
    // silently dropped table.
    const cyclic = collectForeignKeys({
      a_b: { type: 'foreign', table: 'a', cols: ['bId'], refTable: 'b', refCols: ['id'] },
      b_a: { type: 'foreign', table: 'b', cols: ['aId'], refTable: 'a', refCols: ['id'] },
    } as any)
    expect(orderTablesByDependency(['a', 'b'], cyclic).sort()).toEqual(['a', 'b'])
  })
})

describe('SQLite enforcement', () => {
  test('foreign_keys is on before the first query runs', async () => {
    // OFF by default and per-connection. Without it a FOREIGN KEY is stored,
    // reported by PRAGMA foreign_key_list, shown in the dashboard — and
    // enforces nothing. It is deliberately not in the fire-and-forget
    // performance pragma chain: applying `cache_size` late costs speed,
    // applying this late costs a row that was never checked.
    const db = new SQLiteAdapter(':memory:') as any
    expect(await db.query('PRAGMA foreign_keys').all()).toEqual([{ foreign_keys: 1 }])
    await db.close()
  })

  test('and it actually refuses an orphan row', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db.query('CREATE TABLE p (id INTEGER PRIMARY KEY)').run()
    await db.query('CREATE TABLE c (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id))').run()
    let refused = false
    try { await db.query('INSERT INTO c (pid) VALUES (999)').run() } catch { refused = true }
    expect(refused).toBe(true)
    await db.close()
  })

  test('cannot ALTER a foreign key in, so the planner rebuilds instead', () => {
    expect(new SQLiteAdapter(':memory:').supportsAlterForeignKey).toBe(false)
  })
})

describe('Field.Foreign', () => {
  const users: any = { id: { type: 'integer', primary: true, autoIncrement: true }, handle: { type: 'string', length: 40 } }

  test('copies the target column type onto the child', async () => {
    // The reason to prefer the column-level form. MySQL refuses a foreign key
    // whose types differ from the referenced key *exactly* — an INT child
    // against a BIGINT parent is rejected — and the two declarations usually
    // sit pages apart. Copying makes the mismatch unrepresentable.
    const { resolveColumnForeignKeys } = await import('./load')
    const out = resolveColumnForeignKeys(
      {
        users,
        posts: {
          id: { type: 'integer', primary: true },
          authorId: { type: 'integer', _references: { table: 'users', column: 'id' } },
          editor: { type: 'integer', _references: { table: 'users', column: 'handle' } },
        },
      } as any,
      { handleUniq: { type: 'unique', table: 'users', cols: ['handle'] } } as any,
    )
    const posts = out.constraints.posts as any
    expect(posts.authorId.type).toBe('integer')
    // Copied from Varchar(40), width included — introspection cannot be relied
    // on to report the width, so this has to come from the schema.
    expect(posts.editor.type).toBe('string')
    expect(posts.editor.length).toBe(40)
  })

  test('derives a foreign key declaration per referencing column', async () => {
    const { resolveColumnForeignKeys } = await import('./load')
    const out = resolveColumnForeignKeys(
      { users, posts: { authorId: { type: 'integer', _references: { table: 'users', column: 'id' } } } } as any,
      {} as any,
    )
    expect(Object.keys(out.indexes)).toEqual(['fk_posts_author_id'])
    expect((out.indexes as any).fk_posts_author_id).toMatchObject({
      type: 'foreign', table: 'posts', cols: ['authorId'], refTable: 'users', refCols: ['id'],
    })
  })

  test('reports a target that is neither primary nor unique', async () => {
    // SQL forbids it. MySQL and Postgres refuse the CREATE; SQLite accepts the
    // DDL and fails every insert with `foreign key mismatch`, naming two tables
    // and nothing else — so this is caught against the schema instead.
    const { resolveColumnForeignKeys } = await import('./load')
    const out = resolveColumnForeignKeys(
      { users, posts: { editor: { type: 'string', _references: { table: 'users', column: 'handle' } } } } as any,
      {} as any, // no unique() on users.handle
    )
    expect(out.unreferenceable).toEqual(['posts.editor -> users.handle'])
  })

  test('a primary-key target needs no unique index', async () => {
    const { resolveColumnForeignKeys } = await import('./load')
    const out = resolveColumnForeignKeys(
      { users, posts: { authorId: { type: 'integer', _references: { table: 'users', column: 'id' } } } } as any,
      {} as any,
    )
    expect(out.unreferenceable).toEqual([])
  })
})
