import { describe, expect, test } from 'bun:test'
import {
  cellClass,
  cellProps,
  cellText,
  columnKind,
  columnMeta,
  type SchemaColumn,
  sameTable,
} from './meta'

const column = (over: Partial<SchemaColumn> = {}): SchemaColumn => ({
  name: 'value',
  type: 'TEXT',
  notnull: false,
  pk: false,
  kind: 'string',
  nullable: true,
  hasDefault: false,
  ...over,
})

describe('columnKind', () => {
  test('an enum beats its underlying string kind', () => {
    // The server reports `kind: 'string'` with an `enum` list, and a free-text
    // box over a checked list is a guaranteed round trip to `not_in_enum`.
    expect(columnKind(column({ enum: ['a', 'b'] }))).toBe('enum')
  })

  test('an enum beats every other kind, which is why it is checked first', () => {
    // The ordering is the assertion. A checked list is a constraint on the
    // values, so it outranks whatever the underlying storage kind is.
    for (const kind of ['json', 'boolean', 'date', 'integer']) {
      expect(columnKind(column({ kind, enum: ['a', 'b'] }))).toBe('enum')
    }
  })

  test('boolean, date and json each get their own widget', () => {
    expect(columnKind(column({ kind: 'boolean' }))).toBe('boolean')
    expect(columnKind(column({ kind: 'date' }))).toBe('date')
    expect(columnKind(column({ kind: 'json' }))).toBe('json')
  })

  test('everything else is a plain input, including the numeric kinds', () => {
    for (const kind of ['string', 'integer', 'number', 'bigint', 'buffer']) {
      expect(columnKind(column({ kind }))).toBe('text')
    }
  })

  test('an empty enum list is not an enum', () => {
    expect(columnKind(column({ enum: [] }))).toBe('text')
  })
})

describe('columnMeta', () => {
  test('the wire shape narrows into what coerceValue takes', () => {
    const meta = columnMeta(
      column({ kind: 'integer', nullable: false, pk: true, length: 5 }),
    )
    expect(meta).toEqual({
      kind: 'integer',
      nullable: false,
      length: 5,
      enum: undefined,
      hasDefault: false,
      primary: true,
      autoIncrement: undefined,
    })
  })
})

describe('cellText', () => {
  test('NULL is the word, so it cannot be mistaken for an empty string', () => {
    expect(cellText(null)).toBe('NULL')
    expect(cellText(undefined)).toBe('NULL')
    expect(cellText('')).toBe('')
  })

  test('binary is summarised rather than dumped', () => {
    expect(cellText(new Uint8Array([1, 2, 3]))).toBe('3 bytes')
  })

  test('an object renders as JSON', () => {
    expect(cellText({ a: 1 })).toBe('{"a":1}')
    expect(cellText([1, 2])).toBe('[1,2]')
  })

  test('a cyclic object still renders something', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => cellText(cycle)).not.toThrow()
  })
})

describe('cellClass', () => {
  test('a null value is marked so the sheet can style it as absent', () => {
    expect(cellClass(null, column()).split(' ')).toContain('null')
    expect(cellClass('', column()).split(' ')).not.toContain('null')
  })

  test('the widget kind travels with the cell', () => {
    expect(cellClass(1, column({ kind: 'boolean' }))).toContain('k-boolean')
  })

  test('numbers and primary keys are tagged', () => {
    const classes = cellClass(7, column({ pk: true, kind: 'integer' })).split(
      ' ',
    )
    expect(classes).toContain('num')
    expect(classes).toContain('pk')
  })
})

describe('cellProps', () => {
  test('a long value carries the whole of itself as a title', () => {
    const long = 'x'.repeat(80)
    expect(cellProps(long, column()).title).toBe(long)
  })

  test('a short one carries no title, so hover stays meaningful', () => {
    expect(cellProps('short', column()).title).toBeUndefined()
  })
})

describe('sameTable', () => {
  test('the camel and raw spellings of one table are one table', () => {
    // `getForeignKeys()` reports raw names and `getConstraints()` is
    // camel-keyed; comparing literally makes every FK on a snake_case schema
    // invisible.
    expect(sameTable('order_items', 'orderItems')).toBe(true)
    expect(sameTable('Order Items', 'order_items')).toBe(true)
  })

  test('different tables stay different', () => {
    expect(sameTable('orders', 'order_items')).toBe(false)
  })
})
