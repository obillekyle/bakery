import { describe, expect, test } from 'bun:test'
import { filter } from '../shared/filters'
import { equalityFilters, withAt, withoutAt } from './filter-builder'

describe('immutable list edits behind the chips', () => {
  const list = [filter('a', 'eq', '1'), filter('b', 'ne', '2'), filter('c')]

  test('withAt replaces exactly one entry', () => {
    const next = withAt(list, 1, filter('z', 'gt', '9'))
    expect(next.map(f => f.column)).toEqual(['a', 'z', 'c'])
  })

  test('withAt does not mutate the list it was given', () => {
    withAt(list, 0, filter('q'))
    expect(list[0]?.column).toBe('a')
  })

  test('withoutAt removes the entry at that index and no other', () => {
    // An off-by-one here presents as "removing one filter removed a different
    // one", which is a confusing bug to chase from a screenshot.
    expect(withoutAt(list, 0).map(f => f.column)).toEqual(['b', 'c'])
    expect(withoutAt(list, 1).map(f => f.column)).toEqual(['a', 'c'])
    expect(withoutAt(list, 2).map(f => f.column)).toEqual(['a', 'b'])
  })

  test('removing the only filter leaves an empty list', () => {
    expect(withoutAt([filter('a')], 0)).toEqual([])
  })

  test('an out-of-range index changes nothing', () => {
    expect(withoutAt(list, 9)).toHaveLength(3)
    expect(withAt(list, 9, filter('z')).map(f => f.column)).toEqual([
      'a',
      'b',
      'c',
    ])
  })
})

describe('a foreign key as a filter', () => {
  test('one eq per column — which is what replaced ViewState.focus', () => {
    // The old client carried a separate row identity because `filters` was a
    // substring LIKE and `id=1` also matched `11`. `eq` makes the filter the
    // identity.
    expect(equalityFilters({ id: 41 })).toEqual([
      { column: 'id', op: 'eq', value: '41' },
    ])
  })

  test('a composite key becomes several eq filters', () => {
    expect(equalityFilters({ tenant: 'eu', id: 7 })).toEqual([
      { column: 'tenant', op: 'eq', value: 'eu' },
      { column: 'id', op: 'eq', value: '7' },
    ])
  })

  test('values stringify, because the wire carries text', () => {
    // The comparison happens in the database against the column's own type;
    // the ORM binds this as a parameter rather than interpolating it.
    expect(equalityFilters({ n: 0 })[0]?.value).toBe('0')
    expect(equalityFilters({ b: false })[0]?.value).toBe('false')
  })

  test('a NULL column is omitted rather than compared', () => {
    // `col = NULL` is unknown and matches no row.
    expect(equalityFilters({ a: 1, b: null, c: undefined })).toEqual([
      { column: 'a', op: 'eq', value: '1' },
    ])
  })

  test('an empty key is an empty filter list', () => {
    expect(equalityFilters({})).toEqual([])
  })
})
