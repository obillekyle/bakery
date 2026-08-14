import { describe, expect, test } from 'bun:test'
import type { ForeignKeyInfo, SchemaGraph } from './meta'
import { filtersForIncoming, relationsFor } from './relations'

const fk = (over: Partial<ForeignKeyInfo> = {}): ForeignKeyInfo => ({
  table: 'parcels',
  cols: ['courier_id'],
  refTable: 'couriers',
  refCols: ['id'],
  ...over,
})

const graph = (keys: Record<string, ForeignKeyInfo>): SchemaGraph => ({
  foreignKeys: keys,
  identity: {},
  labels: {},
})

describe('grouping the graph by direction', () => {
  test('a key declared on this table is outgoing', () => {
    const relations = relationsFor(graph({ one: fk() }), 'parcels')
    expect(relations.outgoing).toEqual([
      {
        cols: ['courier_id'],
        table: 'couriers',
        refCols: ['id'],
        name: undefined,
      },
    ])
    expect(relations.incoming).toEqual([])
  })

  test('the same key is incoming when read from the other end', () => {
    const relations = relationsFor(graph({ one: fk() }), 'couriers')
    expect(relations.outgoing).toEqual([])
    expect(relations.incoming).toEqual([
      {
        cols: ['courier_id'],
        table: 'parcels',
        refCols: ['id'],
        name: undefined,
      },
    ])
  })

  test('an incoming relation names the REFERENCING table, not this one', () => {
    // The reversal is what makes both lists read the same way on screen: near
    // columns first, far table second. Getting it backwards produces a link
    // that opens the table you are already looking at.
    const relations = relationsFor(graph({ one: fk() }), 'couriers')
    expect(relations.incoming[0]?.table).toBe('parcels')
  })

  test('a snake_case table still matches a camelCased graph entry', () => {
    // `getForeignKeys()` reports raw names and `getConstraints()` camel-cases;
    // comparing literally makes every foreign key on a snake_case schema
    // invisible — the whole feature silently absent.
    const relations = relationsFor(
      graph({ one: fk({ table: 'orderItems', refTable: 'productLines' }) }),
      'order_items',
    )
    expect(relations.outgoing).toHaveLength(1)
    expect(relations.outgoing[0]?.table).toBe('productLines')
  })

  test('a self-reference appears in both lists', () => {
    // It genuinely is a key this table declares and genuinely is a key that
    // points here.
    const self = fk({ table: 'staff', cols: ['manager_id'], refTable: 'staff' })
    const relations = relationsFor(graph({ one: self }), 'staff')
    expect(relations.outgoing).toHaveLength(1)
    expect(relations.incoming).toHaveLength(1)
  })

  test('a composite key keeps both columns and their positional partners', () => {
    const composite = fk({
      cols: ['tenant', 'courier_id'],
      refCols: ['tenant', 'id'],
    })
    const relations = relationsFor(graph({ one: composite }), 'parcels')
    expect(relations.outgoing[0]?.cols).toEqual(['tenant', 'courier_id'])
    expect(relations.outgoing[0]?.refCols).toEqual(['tenant', 'id'])
  })

  test('keys that touch neither end are absent from both lists', () => {
    const other = fk({ table: 'invoices', refTable: 'customers' })
    const relations = relationsFor(graph({ one: other }), 'parcels')
    expect(relations).toEqual({ outgoing: [], incoming: [] })
  })

  test('several keys are all grouped, not just the first match', () => {
    const relations = relationsFor(
      graph({
        a: fk({ cols: ['courier_id'], refTable: 'couriers' }),
        b: fk({ cols: ['depot_id'], refTable: 'depots' }),
        c: fk({ table: 'labels', refTable: 'parcels', cols: ['parcel_id'] }),
      }),
      'parcels',
    )
    expect(relations.outgoing.map(r => r.table)).toEqual(['couriers', 'depots'])
    expect(relations.incoming.map(r => r.table)).toEqual(['labels'])
  })

  test('a constraint name is carried when the dialect reports one', () => {
    const relations = relationsFor(
      graph({ one: fk({ name: 'fk_parcels_courier' }) }),
      'parcels',
    )
    expect(relations.outgoing[0]?.name).toBe('fk_parcels_courier')
  })

  test('no graph is two empty lists, not a throw', () => {
    // The graph is decoration — a fetch failure must not cost anyone the view.
    expect(relationsFor(null, 'parcels')).toEqual({
      outgoing: [],
      incoming: [],
    })
  })
})

describe('the filters that open the rows pointing at one row', () => {
  test('one eq per referencing column, taking values from this row', () => {
    const relation = {
      cols: ['courier_id'],
      table: 'parcels',
      refCols: ['id'],
    }
    expect(filtersForIncoming(relation, { id: 41, name: 'dhl' })).toEqual([
      { column: 'courier_id', op: 'eq', value: '41' },
    ])
  })

  test('a composite reference produces one filter per column pair', () => {
    const relation = {
      cols: ['tenant', 'courier_id'],
      table: 'parcels',
      refCols: ['tenant', 'id'],
    }
    expect(filtersForIncoming(relation, { tenant: 'eu', id: 7 })).toEqual([
      { column: 'tenant', op: 'eq', value: 'eu' },
      { column: 'courier_id', op: 'eq', value: '7' },
    ])
  })

  test('a NULL on the near side is omitted rather than compared', () => {
    // `col = NULL` is unknown and matches no row, so a filter carrying it
    // would silently produce an empty page instead of a partial one.
    const relation = { cols: ['a', 'b'], table: 'x', refCols: ['p', 'q'] }
    expect(filtersForIncoming(relation, { p: 1, q: null })).toEqual([
      { column: 'a', op: 'eq', value: '1' },
    ])
  })
})
