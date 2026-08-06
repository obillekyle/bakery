import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { DB } from './index'

/**
 * Unlike orm.test.ts, these run against a real adapter rather than a stub with
 * `quoteChar: '"'` hardcoded — so they actually verify the dialect's quoting
 * instead of the mock's.
 */
let db: SQLiteAdapter

beforeAll(() => {
  db = new SQLiteAdapter(':memory:')
  __setTestDb(db)
})

afterAll(() => __resetTestDb())

describe('real SQLite identifier quoting', () => {
  test('uses double quotes, not MySQL backticks', () => {
    expect(db.quoteChar).toBe('"')
  })

  test('quote() strips an embedded quote char so it cannot break out', () => {
    expect(db.quote('my"col')).toBe('"mycol"')
    expect(db.quote('normal')).toBe('"normal"')
  })

  test('generated SQL is quoted and actually executes', async () => {
    const { sql } = DB.table('users')
      .select({ teacherId: 'users.id' })
      .where('users.id', 5)
      .parse()

    expect(sql).toBe(
      'SELECT "users"."id" AS "teacherId" FROM "users" WHERE "users"."id" = ?',
    )

    await db.query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)').run()
    await db.query('INSERT INTO users (id, name) VALUES (1, ?)').run('ada')

    const rows = await db.query(sql).all(1)
    expect(rows).toEqual([{ teacherId: 1 }])
  })
})

/**
 * `join(left, right)` built its `ON` clause from the raw right-hand argument
 * when no alias was given. For an undotted right column that argument is a
 * *table* name, and the rewriter in `parse()` only quotes dotted pairs — so
 * `join('teachers.campusId', 'campuses')` emitted
 * `ON "teachers"."campus_id" = campuses`: a bare table name where a column
 * belongs, which no dialect accepts and nothing catches until execution.
 *
 * Resolving it rather than rejecting it, because the meaning was already
 * defined and already implemented: `rightColName` falls back to `id`, and the
 * *aliased* form `join('teachers.campusId', 'campuses', 'c')` has always
 * emitted `"c"."id"`. Only the unaliased path forgot to qualify. Rejecting
 * would have had to break that working call too, or keep the two forms
 * inconsistent.
 *
 * The `as any` below is the other half of that argument: `rightCol` is typed
 * ``AllTableColumns<S>``, so the undotted form is already a compile error and
 * only reaches the builder from JavaScript, a cast, or a runtime-built name. A
 * caller in that position gets no help from a thrown error that the type system
 * would have given them first — but they do get correct SQL.
 */
describe('join always qualifies its right-hand column', () => {
  test('an undotted right column resolves to that table s id', () => {
    const { sql } = DB.table('teachers')
      .join('teachers.campusId', 'campuses' as any)
      .parse()
    expect(sql).toContain(
      'INNER JOIN "campuses" AS "campuses" ON "teachers"."campus_id" = "campuses"."id"',
    )
    // The shape of the old defect, spelled out: no bare identifier survives.
    expect(sql).not.toMatch(/=\s*campuses\b/)
  })

  test('the emitted join runs against a real database', async () => {
    await db.query('CREATE TABLE campuses (id INTEGER PRIMARY KEY, name TEXT)').run()
    await db
      .query(
        'CREATE TABLE teachers (id INTEGER PRIMARY KEY, campus_id INTEGER, surname TEXT)',
      )
      .run()
    await db.query("INSERT INTO campuses (id, name) VALUES (1, 'north')").run()
    await db
      .query("INSERT INTO teachers (id, campus_id, surname) VALUES (1, 1, 'ada')")
      .run()

    const { sql } = DB.table('teachers')
      .join('teachers.campusId', 'campuses' as any)
      .select({ surname: 'teachers.surname', campus: 'campuses.name' })
      .parse()

    // Previously: SQLiteError, no such column: campuses.
    expect(await db.query(sql).all()).toEqual([{ surname: 'ada', campus: 'north' }])
  })

  test('an undotted right column with an alias is unchanged', () => {
    const { sql } = DB.table('teachers')
      .join('teachers.campusId', 'campuses' as any, 'c')
      .parse()
    expect(sql).toContain(
      'INNER JOIN "campuses" AS "c" ON "teachers"."campus_id" = "c"."id"',
    )
  })

  test('a dotted right column is unchanged, aliased or not', () => {
    expect(
      DB.table('teachers').join('teachers.campusId', 'campuses.id').parse().sql,
    ).toContain(
      'INNER JOIN "campuses" AS "campuses" ON "teachers"."campus_id" = "campuses"."id"',
    )
    expect(
      DB.table('teachers')
        .leftJoin('teachers.campusId', 'campuses.siteId', 'c')
        .parse().sql,
    ).toContain(
      'LEFT JOIN "campuses" AS "c" ON "teachers"."campus_id" = "c"."site_id"',
    )
  })
})

describe('safeColumn hardening', () => {
  test('rejects the old matched-paren bypass', () => {
    // Any string containing "(" and ")" used to be returned unchecked.
    expect(() => DB.safeColumn('(1) UNION SELECT password FROM users --')).toThrow()
  })

  test('rejects statement injection and stray parens', () => {
    expect(() => DB.safeColumn('a; DROP TABLE users')).toThrow()
    expect(() => DB.safeColumn('a)')).toThrow()
    expect(() => DB.safeColumn('a"b')).toThrow()
  })

  test('rejects an unknown function name', () => {
    expect(() => DB.safeColumn('EVIL(x)')).toThrow(/Unsupported SQL function/)
  })

  test('still accepts legitimate columns and allow-listed functions', () => {
    expect(DB.safeColumn('*')).toBe('*')
    expect(DB.safeColumn('id')).toBe('"id"')
    expect(DB.safeColumn('users.id')).toBe('"users"."id"')
    expect(DB.safeColumn('COUNT(id)')).toBe('COUNT("id")')
    expect(DB.safeColumn('COUNT(*)')).toBe('COUNT(*)')
  })
})

/**
 * `join()` built its ON clause by concatenating the raw arguments, and
 * `parse()` then ran a `word.word` regex over the result which quoted what
 * matched and **passed everything else through untouched**. `orderBy` and
 * `groupBy` already routed their column through `safeColumn` for exactly this
 * reason; the three join paths did not.
 *
 * The `as any` casts are the same argument the existing join tests make: the
 * `ColumnString` union is compile-time only, so these strings reach the builder
 * from JavaScript, a cast, or a name built at runtime from request data.
 */
describe('join routes every identifier through safeColumn', () => {
  test('a whole SQL clause in the left column is rejected', () => {
    expect(() =>
      DB.table('users').join(
        'users.id = 1 OR 1=1 UNION SELECT password FROM secrets --' as any,
        'posts.userId' as any,
      ),
    ).toThrow(/Invalid or unsafe/)
  })

  test('a whole SQL clause in the right column is rejected', () => {
    expect(() =>
      DB.table('users').join(
        'users.id' as any,
        'posts.userId = 1 OR 1=1 --' as any,
      ),
    ).toThrow(/Invalid or unsafe/)
  })

  test('an injected alias is rejected', () => {
    expect(() =>
      DB.table('users').join(
        'users.id' as any,
        'posts.userId' as any,
        'p" ON 1=1 --' as any,
      ),
    ).toThrow(/Invalid or unsafe/)
  })

  test('leftJoin, rightJoin and innerJoin all inherit the guard', () => {
    const bad = 'a.b = 1 OR 1=1 --' as any
    expect(() => DB.table('users').leftJoin(bad, 'posts.userId' as any)).toThrow()
    expect(() => DB.table('users').rightJoin(bad, 'posts.userId' as any)).toThrow()
    expect(() => DB.table('users').innerJoin(bad, 'posts.userId' as any)).toThrow()
  })

  test('nothing unquoted survives into the emitted ON clause', () => {
    const { sql } = DB.table('users')
      .join('users.id' as any, 'posts.userId' as any)
      .parse()
    expect(sql).toContain(
      'INNER JOIN "posts" AS "posts" ON "users"."id" = "posts"."user_id"',
    )
    expect(sql).not.toMatch(/ON [^"]*[a-zA-Z_]+\.[a-zA-Z_]+/)
  })

  test('an unqualified left column is quoted rather than passed through', () => {
    // The old regex only matched dotted pairs, so a bare column reached the
    // ON clause unquoted.
    const { sql } = DB.table('teachers')
      .join('campusId' as any, 'campuses.id' as any)
      .parse()
    expect(sql).toContain('ON "campus_id" = "campuses"."id"')
  })
})

/**
 * `returning(cols)` was interpolated raw on all three mutation builders, so
 * `.returning('* FROM users; DROP TABLE t --')` was emitted verbatim. It takes
 * an identifier list, which is the position `safeColumn` exists for.
 */
describe('returning() validates its column list', () => {
  const payload = '* FROM users; DROP TABLE t --'

  test('Insert rejects an injected list', () => {
    expect(() =>
      DB.Insert.into('users').values({ a: 1 }).returning(payload),
    ).toThrow(/Invalid or unsafe/)
  })

  test('Update rejects an injected list', () => {
    expect(() =>
      DB.Update.table('users').set({ a: 1 }).where('id', 1).returning(payload),
    ).toThrow(/Invalid or unsafe/)
  })

  test('Delete rejects an injected list', () => {
    expect(() =>
      DB.Delete.from('users').where('id', 1).returning(payload),
    ).toThrow(/Invalid or unsafe/)
  })

  test('a legitimate list is quoted, and * still passes', () => {
    expect(
      DB.Insert.into('users').values({ a: 1 }).returning('*').parse().sql,
    ).toContain('RETURNING *')
    expect(
      DB.Insert.into('users')
        .values({ a: 1 })
        .returning('id, userName')
        .parse().sql,
    ).toContain('RETURNING "id", "user_name"')
  })

  test('the quoted form still executes and returns rows', async () => {
    await db
      .query('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)')
      .run()
    const { sql, params } = DB.Insert.into('notes')
      .values({ id: 1, body: 'hi' })
      .returning('id, body')
      .parse()
    expect(await db.query(sql).all(...params)).toEqual([{ id: 1, body: 'hi' }])
  })
})

describe('orderBy and limit validation', () => {
  test('rejects a sort direction that is not ASC/DESC', () => {
    // The 'ASC' | 'DESC' union is erased at runtime.
    expect(() =>
      DB.table('users').orderBy('id', 'ASC; DROP TABLE users' as any),
    ).toThrow(/Invalid sort direction/)
  })

  test('accepts either direction in any casing', () => {
    expect(DB.table('users').orderBy('id', 'desc' as any).parse().sql).toContain(
      'ORDER BY "id" DESC',
    )
  })

  test('rejects a non-numeric limit or offset', () => {
    expect(() => DB.table('users').limit('1; DROP TABLE users' as any)).toThrow(
      /Invalid limit/,
    )
    expect(() => DB.table('users').limit(10, 'x' as any)).toThrow(/Invalid offset/)
    expect(() => DB.table('users').limit(-1)).toThrow(/Invalid limit/)
  })

  test('coerces a numeric string rather than emitting NaN', () => {
    const { sql } = DB.table('users').limit('10' as any, '5' as any).parse()
    expect(sql).toContain('LIMIT 10 OFFSET 5')
  })
})
