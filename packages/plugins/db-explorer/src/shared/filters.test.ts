import { describe, expect, test } from 'bun:test'
import {
  duplicateColumns,
  FILTER_OPS,
  type FilterOp,
  filter,
  isFilterOp,
  OP_LABELS,
  opTakesValue,
  parseFilters,
  toWire,
} from './filters'

describe('the vocabulary', () => {
  test('it is exactly what the ORM implements', () => {
    // `filterClause` in packages/orm/src/adapters/base.ts. An operator here
    // that the ORM does not know is *dropped* there, which widens the result.
    expect([...FILTER_OPS].sort()).toEqual(
      (
        [
          'contains',
          'ends',
          'eq',
          'gt',
          'gte',
          'lt',
          'lte',
          'ne',
          'notnull',
          'null',
          'starts',
        ] as FilterOp[]
      ).sort(),
    )
  })

  test('every operator has a label', () => {
    for (const op of FILTER_OPS) expect(OP_LABELS[op]).toBeTruthy()
  })

  test('exactly two operators take no value', () => {
    const nullary = FILTER_OPS.filter(op => !opTakesValue(op))
    expect(nullary).toEqual(['null', 'notnull'])
  })

  test('isFilterOp refuses anything else', () => {
    expect(isFilterOp('eq')).toBe(true)
    expect(isFilterOp('regex')).toBe(false)
    expect(isFilterOp('')).toBe(false)
    expect(isFilterOp(1)).toBe(false)
    expect(isFilterOp(null)).toBe(false)
    expect(isFilterOp(undefined)).toBe(false)
  })
})

describe('chips to the wire', () => {
  test('a value-taking operator carries its operand', () => {
    expect(toWire([filter('courier', 'eq', 'dhl')])).toEqual({
      courier: { op: 'eq', value: 'dhl' },
    })
  })

  test('several filters combine', () => {
    expect(
      toWire([filter('a', 'gte', '3'), filter('b', 'contains', 'x')]),
    ).toEqual({
      a: { op: 'gte', value: '3' },
      b: { op: 'contains', value: 'x' },
    })
  })

  test('a nullary operator carries NO value key at all', () => {
    // Not `value: ''` and not `value: undefined` — the ORM binds nothing for
    // `IS NULL`, and a stray parameter is how a placeholder count drifts from
    // its arguments.
    const wire = toWire([filter('note', 'null', 'ignored')])
    expect(wire).toEqual({ note: { op: 'null' } })
    expect('value' in wire.note!).toBe(false)
  })

  test('notnull is the same', () => {
    expect(toWire([filter('note', 'notnull', '')])).toEqual({
      note: { op: 'notnull' },
    })
  })

  test('a half-built chip is not sent', () => {
    // An empty operand under `contains` would be `LIKE '%%'` — every row, while
    // looking like a filter.
    expect(toWire([filter('a', 'contains', '')])).toEqual({})
    expect(toWire([filter('', 'eq', 'x')])).toEqual({})
  })

  test('the last filter on a column wins', () => {
    // The wire shape is keyed by column, so it can carry only one. Last rather
    // than first, because the last is the one the user just touched.
    expect(toWire([filter('a', 'eq', '1'), filter('a', 'ne', '2')])).toEqual({
      a: { op: 'ne', value: '2' },
    })
  })

  test('duplicateColumns names the ones that cannot both be sent', () => {
    expect(
      duplicateColumns([
        filter('a', 'eq', '1'),
        filter('b', 'eq', '2'),
        filter('a', 'ne', '3'),
      ]),
    ).toEqual(['a'])
  })

  test('duplicateColumns is empty when every column is distinct', () => {
    expect(duplicateColumns([filter('a'), filter('b')])).toEqual([])
  })

  test('an empty list is an empty wire, not a missing parameter', () => {
    expect(toWire([])).toEqual({})
  })
})

describe('what the endpoint accepts', () => {
  test('the object form passes through', () => {
    const parsed = parseFilters({ a: { op: 'eq', value: '1' } })
    expect(parsed).toEqual({
      ok: true,
      filters: { a: { op: 'eq', value: '1' } },
    })
  })

  test('a bare scalar still means contains', () => {
    // The pre-operator form. `getData` is public and the dashboard still calls
    // it this way.
    expect(parseFilters({ a: 'dh' })).toEqual({
      ok: true,
      filters: { a: 'dh' },
    })
  })

  test('an unknown operator is REFUSED, not dropped', () => {
    // The direction matters: the ORM drops what it does not know, and a
    // dropped filter shows more rows than were asked for — on the view the
    // Delete button acts on.
    const parsed = parseFilters({ a: { op: 'regex', value: '.*' } })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) {
      expect(parsed.error).toContain('regex')
      expect(parsed.error).toContain('a')
    }
  })

  test('a missing operator is refused too', () => {
    expect(parseFilters({ a: { value: '1' } }).ok).toBe(false)
  })

  test('a nullary operator needs no value and keeps none', () => {
    expect(parseFilters({ a: { op: 'null' } })).toEqual({
      ok: true,
      filters: { a: { op: 'null' } },
    })
  })

  test('a value-taking operator with no value is dropped, not an error', () => {
    // A cleared box, which every caller has always been allowed to send.
    expect(parseFilters({ a: { op: 'eq', value: '' } })).toEqual({
      ok: true,
      filters: {},
    })
    expect(parseFilters({ a: '' })).toEqual({ ok: true, filters: {} })
  })

  test('an array is refused rather than iterated as an object', () => {
    expect(parseFilters([{ op: 'eq' }]).ok).toBe(false)
  })

  test('absent filters are no filters', () => {
    expect(parseFilters(undefined)).toEqual({ ok: true, filters: {} })
    expect(parseFilters(null)).toEqual({ ok: true, filters: {} })
  })

  test('a non-object is refused', () => {
    expect(parseFilters('a=1').ok).toBe(false)
    expect(parseFilters(7).ok).toBe(false)
  })

  test('one bad operator fails the whole request', () => {
    // Partial acceptance would be the widening failure in a subtler costume:
    // the good filters apply, the bad one silently does not.
    expect(
      parseFilters({
        good: { op: 'eq', value: '1' },
        bad: { op: 'sounds-like', value: 'x' },
      }).ok,
    ).toBe(false)
  })

  test('what toWire emits is what parseFilters accepts', () => {
    // The two halves of the contract, checked against each other rather than
    // each against a fixture.
    const wire = toWire(
      FILTER_OPS.map((op, index) => filter(`c${index}`, op, '1')),
    )
    const parsed = parseFilters(wire)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(Object.keys(parsed.filters)).toHaveLength(FILTER_OPS.length)
    }
  })
})
