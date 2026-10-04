import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { collectConstraints, type RowOf, table } from '../define'
import { Field } from '../field'
import { checkSchema } from '../migrate/check'
import type * as SyncTypes from '../sync/types'
import {
  alive,
  type Isolated,
  LIVE_TIMEOUT,
  ownDatabase,
  ownSchema,
} from '../tests/isolated'
import { DB } from './index'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/**
 * Postgres arrays through the query builder: `Field.Array`, `DB.array()` and
 * the containment operators.
 *
 * Three things Bun does that these exist for, each measured: a JavaScript
 * array cannot be bound to an array parameter at all; an `int4[]` comes back
 * as an `Int32Array` once a query has a bound parameter, and as an ordinary
 * array when it has none; and a plain array given to a `jsonb` column stores
 * JSON, which encoding every array as a Postgres literal would have broken.
 */

const roles = table('roles', {
  id: Field.Primary(),
  name: Field.String(),
  permissions: Field.Array('text', { optional: true }),
  floorIds: Field.Array('integer', { optional: true }),
  weights: Field.Array('numeric', { optional: true }),
  meta: Field.Json(true),
})

const BACKSLASH = String.fromCharCode(92)
const AWKWARD = [
  'grades.post',
  'a "quoted", {braced} value',
  `back${BACKSLASH}slash`,
]

describe.skipIf(!PGSQL_URL)('arrays on Postgres', () => {
  let pg: Isolated

  beforeAll(async () => {
    pg = await ownSchema(PGSQL_URL!)
    await alive(
      pg.adapter.executeScript(`
        CREATE TABLE roles (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name text NOT NULL,
          permissions text[] NOT NULL DEFAULT '{}',
          floor_ids integer[] NOT NULL DEFAULT '{}',
          weights numeric[] NOT NULL DEFAULT '{}',
          meta jsonb
        );
      `),
    )
    __setTestDb(pg.adapter)
  }, LIVE_TIMEOUT)

  afterAll(async () => {
    __resetTestDb()
    await pg.drop()
  }, LIVE_TIMEOUT)

  test(
    'Field.Array declares what db:sync checks',
    async () => {
      expect(
        await alive(
          checkSchema(
            pg.adapter,
            collectConstraints({ roles }) as SyncTypes.DBConstraints,
          ),
        ),
      ).toEqual([])
    },
    LIVE_TIMEOUT,
  )

  test(
    'DB.array() writes an array, and it reads back exactly, as plain arrays',
    async () => {
      await alive(
        DB.Insert.into('roles')
          .values({
            name: 'registrar',
            permissions: DB.array(AWKWARD),
            floorIds: DB.array([1, 2, 3]),
            weights: DB.array(['0.25', '0.75']),
            // A plain array into jsonb is still JSON, not a Postgres array.
            meta: [1, 2],
          })
          .run(),
      )

      // A WHERE, so the read has a bound parameter: the case where Bun hands
      // back an Int32Array for the integer[] column.
      const rows = (await alive(
        DB.table('roles').where('name', 'registrar').array(),
      )) as RowOf<typeof roles>[]
      const row = rows[0]!
      expect(row.permissions).toEqual(AWKWARD)
      expect(Array.isArray(row.floorIds)).toBe(true)
      expect(row.floorIds).toEqual([1, 2, 3])
      expect(JSON.stringify(row.floorIds)).toBe('[1,2,3]')
      expect(row.weights).toEqual(['0.25', '0.75'])
      expect(row.meta).toEqual([1, 2])
    },
    LIVE_TIMEOUT,
  )

  test(
    'has, contains and overlaps test membership',
    async () => {
      const names = async (where: unknown, column = 'permissions') =>
        (
          (await alive(
            DB.table('roles')
              .where(column as any, where as any)
              .array(),
          )) as { name: string }[]
        ).map(r => r.name)

      expect(await names(DB.has('grades.post'))).toEqual(['registrar'])
      expect(await names(DB.has('nope'))).toEqual([])
      expect(
        await names(DB.contains(['grades.post', `back${BACKSLASH}slash`])),
      ).toEqual(['registrar'])
      expect(await names(DB.contains(['grades.post', 'nope']))).toEqual([])
      expect(await names(DB.overlaps(['nope', 'grades.post']))).toEqual([
        'registrar',
      ])
      expect(await names(DB.has(2), 'floor_ids')).toEqual(['registrar'])
    },
    LIVE_TIMEOUT,
  )

  test(
    'an update sets an array, empty included',
    async () => {
      await alive(
        DB.Update.table('roles')
          .set({ permissions: DB.array([]), floorIds: DB.array([7]) })
          .where('name', 'registrar')
          .run(),
      )
      const row = (
        (await alive(
          DB.table('roles').where('name', 'registrar').array(),
        )) as RowOf<typeof roles>[]
      )[0]!
      expect(row.permissions).toEqual([])
      expect(row.floorIds).toEqual([7])
    },
    LIVE_TIMEOUT,
  )
})

describe('arrays where there are none', () => {
  test('SQLite refuses DB.array() and says why', async () => {
    const adapter = new SQLiteAdapter(':memory:')
    __setTestDb(adapter)
    try {
      await adapter.executeScript('CREATE TABLE roles (id INTEGER, tags TEXT)')
      let error: unknown
      try {
        await DB.Insert.into('roles')
          .values({ id: 1, tags: DB.array(['a']) })
          .run()
      } catch (caught) {
        error = caught
      }
      expect(String(error)).toContain(
        'DB.array() writes a Postgres array, and the sqlite adapter has no array type',
      )
    } finally {
      __resetTestDb()
      await adapter.close()
    }
  })

  test.skipIf(!MYSQL_URL)(
    'MySQL refuses it too',
    async () => {
      const my = await ownDatabase(MYSQL_URL!)
      __setTestDb(my.adapter)
      try {
        await alive(
          my.adapter.executeScript('CREATE TABLE roles (id INT, tags TEXT)'),
        )
        let error: unknown
        try {
          await alive(
            DB.Insert.into('roles')
              .values({ id: 1, tags: DB.array(['a']) })
              .run(),
          )
        } catch (caught) {
          error = caught
        }
        expect(String(error)).toContain('the mysql adapter has no array type')
      } finally {
        __resetTestDb()
        await my.drop()
      }
    },
    LIVE_TIMEOUT,
  )
})
