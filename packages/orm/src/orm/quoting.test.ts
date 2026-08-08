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

describe('SELECT DISTINCT', () => {
  test('is emitted straight after SELECT, before the column list', () => {
    expect(
      DB.from('teachers').select({ surname: 'teachers.surname' }).distinct().parse().sql,
    ).toBe('SELECT DISTINCT "teachers"."surname" AS "surname" FROM "teachers"')
  })

  test('applies with selectAll and with no select at all', () => {
    expect(DB.from('teachers').selectAll('teachers').distinct().parse().sql).toBe(
      'SELECT DISTINCT "teachers".* FROM "teachers"',
    )
    expect(DB.from('teachers').distinct().parse().sql).toBe(
      'SELECT DISTINCT * FROM "teachers"',
    )
  })

  test('order in the chain does not matter, and it is idempotent', () => {
    // `distinct()` sets a flag rather than appending, so the stage it is called
    // at is irrelevant — the alternative would make `.distinct()` before a
    // `.where()` mean something different from after it.
    const before = DB.from('teachers').distinct().where('teachers.id', 1).parse()
    const after = DB.from('teachers').where('teachers.id', 1).distinct().parse()
    expect(before.sql).toBe(after.sql)
    expect(DB.from('teachers').distinct().distinct().parse().sql).toBe(
      DB.from('teachers').distinct().parse().sql,
    )
  })

  test('clone() does not leak it back to the original', () => {
    // Every other builder field is copied in clone(); a missed one shows up as
    // a query that changes because something *else* was derived from it.
    const base = DB.from('teachers').selectAll('teachers')
    const distinct = base.clone().distinct()
    expect(base.parse().sql).not.toContain('DISTINCT')
    expect(distinct.parse().sql).toContain('DISTINCT')
  })

  test('actually de-duplicates against a real database', async () => {
    await db.query('DROP TABLE IF EXISTS d_test').run()
    await db.query('CREATE TABLE d_test (city TEXT NOT NULL)').run()
    await db.query("INSERT INTO d_test (city) VALUES ('a'), ('a'), ('b')").run()

    const all = await db.query('SELECT city FROM d_test').all()
    const distinct = await db.query('SELECT DISTINCT city FROM d_test').all()
    expect(all.length).toBe(3)
    expect(distinct.length).toBe(2)
    await db.query('DROP TABLE IF EXISTS d_test').run()
  })
})

describe('DISTINCT inside an aggregate', () => {
  test('count/sum/avg have a .distinct form', () => {
    const sql = (fn: any) =>
      DB.from('teachers').select({ n: fn }).parse().sql
    expect(sql(DB.count.distinct('teachers.surname'))).toBe(
      'SELECT COUNT(DISTINCT "teachers"."surname") AS "n" FROM "teachers"',
    )
    expect(sql(DB.sum.distinct('teachers.id'))).toContain('SUM(DISTINCT')
    expect(sql(DB.avg.distinct('teachers.id'))).toContain('AVG(DISTINCT')
    // …and the plain form is untouched.
    expect(sql(DB.count('teachers.id'))).toBe(
      'SELECT COUNT("teachers"."id") AS "n" FROM "teachers"',
    )
  })

  test('composes with, and is distinct from, SELECT DISTINCT', () => {
    // Two different things: one de-duplicates the rows, the other the values
    // fed to the aggregate. Both can appear in one query.
    expect(
      DB.from('teachers')
        .select({ n: DB.count.distinct('teachers.surname') })
        .distinct()
        .parse().sql,
    ).toBe(
      'SELECT DISTINCT COUNT(DISTINCT "teachers"."surname") AS "n" FROM "teachers"',
    )
  })

  test('works in HAVING as well as the select list', () => {
    const { sql } = DB.from('teachers')
      .select({ n: DB.count.distinct('teachers.surname') })
      .groupBy('teachers.id')
      .having(DB.count.distinct('teachers.surname'), 2)
      .parse()
    expect(sql).toContain('HAVING COUNT(DISTINCT "teachers"."surname")')
  })

  test('a function in the select list keeps its extra arguments', () => {
    // Regression: the select clause re-implemented function rendering and never
    // read `extraArgs`, so COALESCE lost its fallback and returned NULL — while
    // the identical call inside a WHERE was correct. Both go through
    // `evalOperands` now, which is also what binds the argument rather than
    // interpolating it.
    const { sql, params } = DB.from('teachers')
      .select({ v: DB.coalesce('teachers.surname', 'n/a') })
      .parse()
    expect(sql).toBe(
      'SELECT COALESCE("teachers"."surname", ?) AS "v" FROM "teachers"',
    )
    expect(params).toEqual(['n/a'])
  })

  test('counts distinct values against a real database', async () => {
    await db.query('DROP TABLE IF EXISTS ad_test').run()
    await db.query('CREATE TABLE ad_test (city TEXT NOT NULL)').run()
    await db.query("INSERT INTO ad_test (city) VALUES ('a'), ('a'), ('b')").run()

    const plain: any = await db.query('SELECT COUNT(city) AS n FROM ad_test').get()
    const dist: any = await db
      .query('SELECT COUNT(DISTINCT city) AS n FROM ad_test')
      .get()
    expect(Number(plain.n)).toBe(3)
    expect(Number(dist.n)).toBe(2)
    await db.query('DROP TABLE IF EXISTS ad_test').run()
  })
})

describe('upsert', () => {
  test('emits ON CONFLICT … DO UPDATE, quoting every identifier', () => {
    expect(
      DB.Insert.into('teachers')
        .values({ surname: 'a', campus: 'b' })
        .upsert(['surname'])
        .parse().sql,
    ).toBe(
      'INSERT INTO "teachers" ("surname", "campus") VALUES (?, ?) ' +
        'ON CONFLICT ("surname") DO UPDATE SET "campus" = excluded."campus"',
    )
  })

  test('updates every inserted column except the conflict key by default', () => {
    const { sql } = DB.Insert.into('teachers')
      .values({ surname: 'a', campus: 'b', room: 'c' })
      .upsert(['surname'])
      .parse()
    expect(sql).toContain('"campus" = excluded."campus"')
    expect(sql).toContain('"room" = excluded."room"')
    // The key identifies the row; overwriting it with itself is noise.
    expect(sql).not.toContain('"surname" = excluded."surname"')
  })

  test('a narrowed list leaves the other columns alone', () => {
    const { sql } = DB.Insert.into('teachers')
      .values({ surname: 'a', campus: 'b', room: 'c' })
      .upsert(['surname'], ['campus'])
      .parse()
    expect(sql).toContain('"campus" = excluded."campus"')
    expect(sql).not.toContain('"room"= excluded."room"')
    expect(sql).not.toContain('"room" = excluded."room"')
  })

  test('an empty update list is insert-if-absent', () => {
    expect(
      DB.Insert.into('teachers')
        .values({ surname: 'a', campus: 'b' })
        .upsert(['surname'], [])
        .parse().sql,
    ).toContain('ON CONFLICT ("surname") DO NOTHING')
  })

  test('inserting only the conflict column has nothing to update', () => {
    // Not a special case in the code — it falls out of "everything except the
    // key", and DO NOTHING is the correct statement for it.
    expect(
      DB.Insert.into('teachers').values({ surname: 'a' }).upsert(['surname']).parse().sql,
    ).toContain('DO NOTHING')
  })

  test('composes with returning', () => {
    const { sql } = DB.Insert.into('teachers')
      .values({ surname: 'a', campus: 'b' })
      .upsert(['surname'])
      .returning('*')
      .parse()
    expect(sql.indexOf('ON CONFLICT')).toBeLessThan(sql.indexOf('RETURNING'))
  })

  test('refuses an empty conflict target', () => {
    // Postgres and SQLite cannot express the statement without one, and
    // silently falling back to a plain INSERT would reintroduce the race the
    // method exists to remove.
    expect(() =>
      DB.Insert.into('teachers').values({ surname: 'a' }).upsert([]),
    ).toThrow()
  })

  test('two upserts leave one row, against a real database', async () => {
    await db.query('DROP TABLE IF EXISTS up_q').run()
    await db.query('CREATE TABLE up_q (email TEXT NOT NULL, name TEXT NOT NULL)').run()
    await db.query('CREATE UNIQUE INDEX up_q_email ON up_q (email)').run()

    await DB.Insert.into('up_q').values({ email: 'a@b.c', name: 'first' }).upsert(['email']).run()
    await DB.Insert.into('up_q').values({ email: 'a@b.c', name: 'second' }).upsert(['email']).run()

    const rows: any[] = await db.query('SELECT * FROM up_q').all()
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('second')
    await db.query('DROP TABLE IF EXISTS up_q').run()
  })
})
