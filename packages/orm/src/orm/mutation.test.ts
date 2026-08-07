import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __resetTestDb, __setTestDb } from '../connection'
import { SQLiteAdapter } from '../adapters/sqlite'
import { DB } from './query'
import { Mutation } from './mutation'

// A real in-memory SQLite adapter rather than a `quoteChar` stub: `parse()`
// only needs the quote character, but the execution block below needs a
// database, and one seam for the file is fewer moving parts than two. Set
// through the connection test seam, never `mock.module` — Bun's module mocks
// are process-global and never restored.
let db: SQLiteAdapter

beforeAll(async () => {
  db = new SQLiteAdapter(':memory:')
  __setTestDb(db)
  await db
    .query('CREATE TABLE sessions (id INTEGER PRIMARY KEY, email TEXT)')
    .run()
  await db
    .query('INSERT INTO sessions (id, email) VALUES (?, ?), (?, ?)')
    .run(1, 'Keep@example.com', 2, 'Drop@example.com')
})

afterAll(() => {
  __resetTestDb()
  db.close?.()
})

/**
 * The *declared* overload is pre-existing debt rather than anything this fix
 * introduces: `QB.where` types its column as `WhereColumn`, which includes
 * `QBRaw | QBObject`, while Update's and Delete's overloads narrow it to a
 * column string. Runtime accepts all three on all of them. Widening six
 * mutation signatures is a public-surface change belonging to the tracked "ORM
 * fluent-API typing gap", so the form is cast at the call site here —
 * deliberately, rather than `@ts-nocheck`-ing the file, which is what
 * `orm.test.ts` does and which would also stop checking the assertions that
 * matter.
 */
const clause = (builder: unknown): any => builder

/**
 * `parseWhereArgs` emits `operator: ''` for the one-argument form —
 * `where(<anything exposing .parse()>)`, which is what `DB.raw` and a subquery
 * builder both are. Such a clause has no right operand, so it must render as
 * the left operand alone.
 *
 * `QB`'s `formatClause` (query.ts) and `UpdateExecutable.evalWhere` both branch
 * on it. `DeleteExecutable.evalWhere` was a copy of the Update one that never
 * received that branch, so it appended an operator that is the empty string and
 * a right operand that is `undefined` — and `evalOperands(undefined)` does not
 * throw, it *binds*: the statement gained a trailing `?` with no operator in
 * front of it and the parameter list gained an `undefined` at a position the
 * visible query does not account for.
 *
 * Reachable straight through the public API: `DB.raw` is exported, `DB.Delete`
 * is exported, and both `where()` implementations take `(column: any,
 * valueOrRef?: any)` and hand it to `parseWhereArgs` unchanged.
 */
describe('Mutation.DeleteExecutable — operator-less WHERE clauses', () => {
  test('a raw WHERE renders as the clause alone, as it does on Update', () => {
    const email = 'admin@example.com'

    const del = Mutation.Delete.from('sessions').where(
      clause(DB.raw`LOWER(email) = ${email}`),
    )
    const update = Mutation.Update.table('sessions')
      .set({ expired: true })
      .where(clause(DB.raw`LOWER(email) = ${email}`))

    expect(del.parse()).toEqual({
      sql: 'DELETE FROM "sessions" WHERE (LOWER(email) = ?)',
      params: [email],
    })
    // The Update twin asserted in the same test, so the pair cannot drift
    // apart again without something going red.
    expect(update.parse().sql).toBe(
      'UPDATE "sessions" SET "expired" = ? WHERE (LOWER(email) = ?)',
    )
  })

  test('a raw WHERE composes with chained conditions', () => {
    const del = Mutation.Delete.from('sessions')
      .where(clause(DB.raw`json_array_length(data) = 0`))
      .and('user_id', 5)
      .or('expired', true)

    expect(del.parse()).toEqual({
      sql:
        'DELETE FROM "sessions" WHERE (json_array_length(data) = 0) ' +
        'AND "user_id" = ? OR "expired" = TRUE',
      params: [5],
    })
  })

  test('an ordinary WHERE is unaffected', () => {
    // The branch being added must not change the two-argument form, which is
    // every other call site in the repo.
    const del = Mutation.Delete.from('sessions')
      .where('user_id', 5)
      .and('expired', true)

    expect(del.parse()).toEqual({
      sql: 'DELETE FROM "sessions" WHERE "user_id" = ? AND "expired" = TRUE',
      params: [5],
    })
  })

  test('a subquery WHERE binds only the subquery parameters', () => {
    const stale = DB.from('users')
      .where('status', 'deleted')
      .select({ id: 'users.id' })

    const { sql, params } = Mutation.Delete.from('sessions')
      .where(clause(stale))
      .parse()

    expect(params).toEqual(['deleted'])
    expect(sql).toBe(
      'DELETE FROM "sessions" WHERE (SELECT "users"."id" AS "id" ' +
        'FROM "users" WHERE "status" = ?)',
    )
  })
})

describe('Mutation.DeleteExecutable — executes against SQLite', () => {
  // The SQL-string assertions above are the primary evidence; this proves the
  // malformed form is not merely ugly but rejected by the database, and that
  // `exists()` — which calls `evalWhere` itself rather than through `parse()`
  // — is fixed by the same change.
  test('run() and exists() both accept a raw WHERE', async () => {
    const target = 'drop@example.com'

    expect(
      await Mutation.Delete.from('sessions')
        .where(clause(DB.raw`LOWER(email) = ${target}`))
        .exists(),
    ).toBe(true)

    const result = await Mutation.Delete.from('sessions')
      .where(clause(DB.raw`LOWER(email) = ${target}`))
      .run()
    expect(result.changes).toBe(1)

    const left = (await db.query('SELECT id FROM sessions').all()) as {
      id: number
    }[]
    expect(left.map(r => r.id)).toEqual([1])
  })
})
