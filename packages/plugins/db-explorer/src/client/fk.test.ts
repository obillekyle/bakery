import { describe, expect, test } from 'bun:test'
import { cacheKey, fkForColumn, fkKeyOf, fkLabel, reverseFks } from './fk'
import type { SchemaGraph } from './meta'

/** The pure half of `fk.ts` — the graph reasoning, with no timers in it. */
const graph: SchemaGraph = {
  foreignKeys: {
    'parcel->courier': {
      table: 'parcels',
      cols: ['courier_id'],
      refTable: 'couriers',
      refCols: ['id'],
    },
    'leg->pair': {
      table: 'legs',
      cols: ['from_hub', 'to_hub'],
      refTable: 'hubs',
      refCols: ['a', 'b'],
    },
  },
  identity: {
    couriers: { mode: 'pk', cols: ['id'] },
    hubs: { mode: 'pk', cols: ['a', 'b'] },
  },
  labels: { couriers: 'name', hubs: null },
}

describe('fkForColumn', () => {
  test('a column that participates in a key finds it', () => {
    expect(fkForColumn(graph, 'parcels', 'courier_id')?.refTable).toBe(
      'couriers',
    )
  })

  test('the camel spelling of a table is the same table', () => {
    // `getForeignKeys()` reports raw names, `getConstraints()` camel ones.
    expect(fkForColumn(graph, 'orderItems', 'x')).toBeNull()
    expect(fkForColumn(graph, 'parcels', 'weight')).toBeNull()
  })

  test('a composite key answers for each of its columns', () => {
    expect(fkForColumn(graph, 'legs', 'from_hub')?.refCols).toEqual(['a', 'b'])
    expect(fkForColumn(graph, 'legs', 'to_hub')?.refCols).toEqual(['a', 'b'])
  })

  test('no graph is not an error', () => {
    expect(fkForColumn(null, 'parcels', 'courier_id')).toBeNull()
  })
})

describe('fkKeyOf', () => {
  const target = fkForColumn(graph, 'legs', 'from_hub')!

  test('the key is written in the referenced table’s column names', () => {
    expect(fkKeyOf(target, { from_hub: 1, to_hub: 2 })).toEqual({ a: 1, b: 2 })
  })

  test('a NULL anywhere in the key points at nothing, so no request is made', () => {
    // `NULL` in a predicate matches no row; issuing the lookup would spend a
    // round trip to learn that.
    expect(fkKeyOf(target, { from_hub: 1, to_hub: null })).toBeNull()
    expect(fkKeyOf(target, { from_hub: 1 })).toBeNull()
  })
})

describe('cacheKey', () => {
  test('is stable regardless of the order the key was built in', () => {
    expect(cacheKey('hubs', { a: 1, b: 2 })).toBe(
      cacheKey('hubs', { b: 2, a: 1 }),
    )
  })

  test('separates tables and values', () => {
    expect(cacheKey('hubs', { a: 1 })).not.toBe(cacheKey('couriers', { a: 1 }))
    expect(cacheKey('hubs', { a: 1 })).not.toBe(cacheKey('hubs', { a: 2 }))
  })
})

describe('fkLabel', () => {
  test('the server’s label column is what a reference reads as', () => {
    expect(fkLabel(graph, 'couriers', { id: 4, name: 'dhl' })).toBe('dhl')
  })

  test('with no label column it falls back to the identity', () => {
    expect(fkLabel(graph, 'hubs', { a: 1, b: 2, x: 'z' })).toBe('1 / 2')
  })

  test('an unresolved reference has no label at all', () => {
    expect(fkLabel(graph, 'couriers', null)).toBeNull()
  })
})

describe('reverseFks', () => {
  test('finds the keys pointing at a table, for the drawer', () => {
    expect(reverseFks(graph, 'couriers').map(fk => fk.table)).toEqual([
      'parcels',
    ])
    expect(reverseFks(graph, 'parcels')).toEqual([])
  })
})
