import { expect, test } from 'bun:test'
import type { InsertRecord, PgArray } from '../array-value'
import { type InsertOf, type RowOf, table } from '../define'
import { Field } from '../field'
import { DB } from './index'

/**
 * `DB.array()` against `Field.Array` columns, at the type level. Typechecked
 * with the rest of the package, so a `@ts-expect-error` that stops being an
 * error fails `bun run typecheck`.
 *
 * Shipped broken in 2.2.0: an insert of `DB.array(ids)` into an
 * `integer[]` column declared with `Field.Array` failed tsc ("ArrayValue
 * <number> is missing the following properties from type number[]"), and
 * the documented way to write an array needed `as unknown as number[]`. The
 * examples in docs/orm passed only because docs compile against an untyped
 * schema.
 */

const roles = table('roles', {
  id: Field.Primary(),
  name: Field.String(),
  floorIds: Field.Array('integer', { optional: true }),
  tags: Field.Array('text', { nullable: true }),
  // An array of another kind: JSON, which takes a plain array.
  scores: Field.Sql<number[]>('jsonb', { optional: true }),
})

test('an insert into a Field.Array column takes DB.array() of its elements', () => {
  const row: InsertOf<typeof roles> = {
    name: 'registrar',
    floorIds: DB.array([1, 2]),
    tags: null,
  }

  // A plain array cannot be bound to a Postgres array.
  // @ts-expect-error
  const plain: InsertOf<typeof roles> = { name: 'x', floorIds: [1, 2] }

  // @ts-expect-error the elements are the column's
  const wrong: InsertOf<typeof roles> = { name: 'x', floorIds: DB.array(['a']) }

  expect([row, plain, wrong]).toHaveLength(3)
})

test('a JSON column typed as an array keeps taking a plain one', () => {
  const row: InsertOf<typeof roles> = { name: 'x', tags: null, scores: [1, 2] }
  // @ts-expect-error an array literal is not JSON
  const literal: InsertOf<typeof roles> = { name: 'x', scores: DB.array([1]) }
  expect([row, literal]).toHaveLength(2)
})

test('the same rule for a schema registered by declaration merging', () => {
  // What `Mutation.InsertSchema` builds from an app's `DBSchema` entry.
  type Row = { id: number; permissions: PgArray<string>; notes: unknown }
  const row: InsertRecord<Row, 'id'> = {
    permissions: DB.array(['grades.post']),
    notes: [1, 2],
  }
  // @ts-expect-error
  const plain: InsertRecord<Row, 'id'> = { permissions: ['x'], notes: null }
  expect([row, plain]).toHaveLength(2)
})

test('a read is a plain array, and a row can be built from one', () => {
  const read: RowOf<typeof roles> = {
    id: 1,
    name: 'registrar',
    floorIds: [1, 2],
    tags: null,
    scores: [],
  }
  const list: number[] = read.floorIds
  expect(read.floorIds).toEqual([1, 2])
  expect(list).toHaveLength(2)
})

test('a comparison takes DB.array()', () => {
  // Not parsed: that needs a database, and arrays.test.ts runs it on Postgres.
  const query = DB.from('roles').where('roles.tags', DB.array(['a']))
  expect(query).toBeDefined()
})
