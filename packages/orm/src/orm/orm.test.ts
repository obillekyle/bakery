// @ts-nocheck
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __resetTestDb, __setTestDb } from '../connection'

const mockDb = {
  quoteChar: '"',
  transaction: async (cb: any) => cb({ execute: async () => [] }),
}

// Use the connection test seam rather than `mock.module`: module mocks are
// process-global in Bun and leak into every later test file.
beforeAll(() => __setTestDb(mockDb))
afterAll(() => __resetTestDb())

import { DB, Mutation } from './index'

describe('Unified ORM Query Builder (DB.table)', () => {
  test('builds simple SELECT * FROM table', () => {
    const qb = DB.table('users')
    const { sql, params } = qb.parse()
    expect(sql).toBe('SELECT * FROM "users"')
    expect(params).toEqual([])
  })

  test('automatically exposes camelCase keys on query result rows', async () => {
    mockDb.query = () => ({
      all: async () => [
        {
          subject_code: 'AAp 113',
          subject_title: 'Art Appreciation',
          type_id: 1,
        },
      ],
      get: async () => ({
        subject_code: 'AAp 113',
        subject_title: 'Art Appreciation',
        type_id: 1,
      }),
    })
    const list = await DB.table('subjects').array()
    expect(list[0].subject_code).toBe('AAp 113')
    expect(list[0].subjectCode).toBe('AAp 113')
    expect(list[0].subjectTitle).toBe('Art Appreciation')
    expect(list[0].typeId).toBe(1)
  })

  test('builds SELECT with specific columns & aliases', () => {
    const qb = DB.table('teachers').select({
      teacherId: 'teachers.id',
      fullName: 'teachers.surname',
    })
    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT "teachers"."id" AS "teacherId", "teachers"."surname" AS "fullName" FROM "teachers"',
    )
  })

  test('builds WHERE clause with 2-argument implicit equality', () => {
    const qb = DB.table('users').where('users.id', 5)
    const { sql, params } = qb.parse()
    expect(sql).toBe('SELECT * FROM "users" WHERE "users"."id" = ?')
    expect(params).toEqual([5])
  })

  test('builds WHERE clause with literal dot string', () => {
    const qb = DB.table('users').where('email', 'john.doe@example.com')
    const { sql, params } = qb.parse()
    expect(sql).toBe('SELECT * FROM "users" WHERE "email" = ?')
    expect(params).toEqual(['john.doe@example.com'])
  })

  test('builds column-to-column comparison via DB.col and DB.cols alias', () => {
    const qb1 = DB.table('users').where('first_name', DB.col('last_name'))
    const { sql: sql1, params: params1 } = qb1.parse()
    expect(sql1).toBe('SELECT * FROM "users" WHERE "first_name" = "last_name"')
    expect(params1).toEqual([])

    const qb2 = DB.table('users').where('first_name', DB.cols('last_name'))
    const { sql: sql2, params: params2 } = qb2.parse()
    expect(sql2).toBe('SELECT * FROM "users" WHERE "first_name" = "last_name"')
    expect(params2).toEqual([])
  })

  test('chains and and or with DB.col', () => {
    const qb = DB.table('users')
      .where('users.status', 'active')
      .and('users.firstName', DB.col('users.lastName'))
      .or('users.shippingAddress', DB.col('users.billingAddress'))

    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "users" WHERE "users"."status" = ? AND "users"."first_name" = "users"."last_name" OR "users"."shipping_address" = "users"."billing_address"',
    )
    expect(params).toEqual(['active'])
  })

  test('builds JOIN clauses', () => {
    const qb = DB.table('teachers').join('teachers.campusId', 'campuses.id')
    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "teachers" INNER JOIN "campuses" AS "campuses" ON "teachers"."campus_id" = "campuses"."id"',
    )
  })

  test('builds GROUP BY & HAVING', () => {
    const qb = DB.table('students')
      .groupBy('students.course')
      .select({ total: DB.sum('students.year') })
      .having(DB.sum('students.year'), DB.gt(1000))

    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT SUM("students"."year") AS "total" FROM "students" GROUP BY "students"."course" HAVING SUM("students"."year") > ?',
    )
    expect(params).toEqual([1000])
  })

  test('builds multi-column ORDER BY and LIMIT/OFFSET', () => {
    const qb = DB.table('products')
      .selectAll()
      .orderBy('category', 'ASC')
      .orderBy('price', 'DESC')
      .limit(10, 20)

    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT "products".* FROM "products" ORDER BY "category" ASC, "price" DESC LIMIT 10 OFFSET 20',
    )
  })

  test('supports CTE / WITH queries', () => {
    const activeUsers = DB.table('users').where('status', 'active')
    const qb = DB.include(activeUsers, 'active_users')
      .table('active_users')
      .selectAll()

    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'WITH "active_users" AS (SELECT * FROM "users" WHERE "status" = ?) SELECT "active_users".* FROM "active_users"',
    )
    expect(params).toEqual(['active'])
  })

  test('clones query builder without mutating base instance', () => {
    const base = DB.table('users').where('status', 'active')
    const clone1 = base.clone().orderBy('created_at', 'DESC').limit(10)
    const clone2 = base.clone().orderBy('name', 'ASC').limit(50)

    expect(base.parse().sql).toBe('SELECT * FROM "users" WHERE "status" = ?')
    expect(clone1.parse().sql).toBe(
      'SELECT * FROM "users" WHERE "status" = ? ORDER BY "created_at" DESC LIMIT 10',
    )
    expect(clone2.parse().sql).toBe(
      'SELECT * FROM "users" WHERE "status" = ? ORDER BY "name" ASC LIMIT 50',
    )
  })

  test('omits unaliased table name from scope when alias is provided', () => {
    const qb = DB.from('campuses')
      .leftJoin('campuses.id', 'teachers.campusId', 't')
      .select({
        campusId: 'campuses.id',
        teacherSurname: 't.surname',
      })

    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT "campuses"."id" AS "campusId", "t"."surname" AS "teacherSurname" FROM "campuses" LEFT JOIN "teachers" AS "t" ON "campuses"."id" = "t"."campus_id"',
    )
  })

  test('executes DB.transaction callback with active transaction context', async () => {
    let transactionRan = false
    const result = await DB.transaction(async tx => {
      transactionRan = true
      expect(tx).toBeDefined()
      return 'txn_result'
    })

    expect(result).toBe('txn_result')
    expect(transactionRan).toBe(true)
  })

  test('supports inline math helpers inside unified .select()', () => {
    const qb = DB.from('campuses')
      .leftJoin('campuses.id', 'teachers.campusId', 't')
      .groupBy('campuses.id')
      .select({
        id: 'campuses.id',
        name: 'campuses.name',
        facultyCount: DB.count('t.id'),
        maxCampusId: DB.max('t.campusId'),
      })

    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT "campuses"."id" AS "id", "campuses"."name" AS "name", COUNT("t"."id") AS "facultyCount", MAX("t"."campus_id") AS "maxCampusId" FROM "campuses" LEFT JOIN "teachers" AS "t" ON "campuses"."id" = "t"."campus_id" GROUP BY "campuses"."id"',
    )
  })

  test('supports tagged template literal DB.col`table.col` and DB.equals()', () => {
    const qb = DB.from('campuses')
      .leftJoin('campuses.id', 'teachers.campusId', 't')
      .where('campuses.id', DB.equals(DB.col('t.campusId')))
      .and(DB.lower('t.email'), DB.equals('admin@example.com'))
      .and('t.nickname', DB.isNotNull())

    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "campuses" LEFT JOIN "teachers" AS "t" ON "campuses"."id" = "t"."campus_id" WHERE "campuses"."id" = "t"."campus_id" AND LOWER("t"."email") = ? AND "t"."nickname" IS NOT NULL',
    )
    expect(params).toEqual(['admin@example.com'])
  })

  test('supports operator helpers DB.gte, DB.inList, DB.between', () => {
    const qb = DB.from('students')
      .where('students.year', DB.gte(2))
      .and('students.course', DB.inList(['BSCS', 'BSIT']))
      .and('students.id', DB.between(10, 50))

    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "students" WHERE "students"."year" >= ? AND "students"."course" IN (?, ?) AND "students"."id" BETWEEN ? AND ?',
    )
    expect(params).toEqual([2, 'BSCS', 'BSIT', 10, 50])
  })

  test('supports tagged template DB.raw`...` with parameter binding', () => {
    const emailVal = 'admin@example.com'
    const qb = DB.from('teachers').where(
      DB.raw`LOWER(email) = ${emailVal} AND status = 'active'`,
    )
    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "teachers" WHERE (LOWER(email) = ? AND status = \'active\')',
    )
    expect(params).toEqual(['admin@example.com'])
  })

  test('supports .paginate(page, pageSize)', () => {
    const qb = DB.from('students')
      .selectAll()
      .orderBy('id', 'DESC')
      .paginate(2, 20)
    const { sql } = qb.parse()
    expect(sql).toBe(
      'SELECT "students".* FROM "students" ORDER BY "id" DESC LIMIT 20 OFFSET 20',
    )
  })

  test('supports subquery in DB.inList()', () => {
    const activeCampuses = DB.from('campuses')
      .where('code', 'active')
      .select({ id: 'campuses.id' })
    const qb = DB.from('teachers').where(
      'teachers.campusId',
      DB.inList(activeCampuses),
    )
    const { sql, params } = qb.parse()
    expect(sql).toBe(
      'SELECT * FROM "teachers" WHERE "teachers"."campus_id" IN (SELECT "campuses"."id" AS "id" FROM "campuses" WHERE "code" = ?)',
    )
    expect(params).toEqual(['active'])
  })

  test('provides .value() and .scalar() execution methods', () => {
    const qb = DB.from('teachers').select({ count: DB.count('*') })
    expect(typeof qb.value).toBe('function')
    expect(qb.scalar).toBe(qb.value)
  })
})

describe('Unified ORM Mutation Builder', () => {
  test('builds Insert queries', () => {
    const insert = Mutation.Insert.into('users').values({
      name: 'Alice',
      email: 'alice@example.com',
    })
    const { sql, params } = insert.parse()
    expect(sql).toBe('INSERT INTO "users" ("name", "email") VALUES (?, ?)')
    expect(params).toEqual(['Alice', 'alice@example.com'])
  })

  test('builds Insert queries with RETURNING clause', () => {
    const insert = Mutation.Insert.into('users')
      .values({ name: 'Alice', email: 'alice@example.com' })
      .returning('*')
    const { sql, params } = insert.parse()
    expect(sql).toBe(
      'INSERT INTO "users" ("name", "email") VALUES (?, ?) RETURNING *',
    )
    expect(params).toEqual(['Alice', 'alice@example.com'])
  })

  test('builds Update queries with chained conditions', () => {
    const update = Mutation.Update.table('users')
      .set({ status: 'archived' })
      .where('role', 'user')
      .and('first_name', DB.col('last_name'))

    const { sql, params } = update.parse()
    expect(sql).toBe(
      'UPDATE "users" SET "status" = ? WHERE "role" = ? AND "first_name" = "last_name"',
    )
    expect(params).toEqual(['archived', 'user'])
  })

  test('builds Delete queries with chained conditions', () => {
    const del = Mutation.Delete.from('sessions')
      .where('user_id', 5)
      .and('expired', true)

    const { sql, params } = del.parse()
    expect(sql).toBe(
      'DELETE FROM "sessions" WHERE "user_id" = ? AND "expired" = TRUE',
    )
    expect(params).toEqual([5])
  })
})
