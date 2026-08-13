import { describe, expect, test } from 'bun:test'
import {
  type ColumnMeta,
  coerceValue,
  comparableKind,
  omittableOnInsert,
  sameValue,
} from './coerce'

/**
 * The dashboard's editor bugs, written as assertions.
 *
 * Each `test` below names one, and each of them was a real value silently
 * changed on the way to the database rather than an error anyone saw.
 */

const meta = (over: Partial<ColumnMeta> = {}): ColumnMeta => ({
  kind: 'string',
  nullable: false,
  hasDefault: false,
  ...over,
})

const value = (raw: unknown, m: ColumnMeta) => {
  const result = coerceValue(raw, m)
  return result.ok ? result.value : `!${result.code}`
}

describe('the three wire states', () => {
  test('null is SQL NULL on a nullable column and an error on a NOT NULL one', () => {
    expect(value(null, meta({ nullable: true }))).toBe(null)
    expect(value(null, meta({ nullable: false }))).toBe('!not_null')
  })

  test('"" is the empty string in text, and never NULL', () => {
    expect(value('', meta({ kind: 'string', nullable: true }))).toBe('')
  })

  test('"" into a numeric column is an error, not zero', () => {
    // The bug: `Number('')` is 0, so an emptied cell became 0 rather than
    // being refused or left alone.
    expect(value('', meta({ kind: 'integer' }))).toBe('!empty_string')
    expect(value('', meta({ kind: 'number' }))).toBe('!empty_string')
  })

  test('"" into a boolean or date column is an error, not false or 1970', () => {
    expect(value('', meta({ kind: 'boolean' }))).toBe('!empty_string')
    expect(value('', meta({ kind: 'date' }))).toBe('!empty_string')
  })

  test('"" is refused even where the column is nullable — it is not a null', () => {
    expect(value('', meta({ kind: 'integer', nullable: true }))).toBe(
      '!empty_string',
    )
  })
})

describe('the column decides, not the characters', () => {
  test('"007" stays a string in a text column', () => {
    expect(value('007', meta({ kind: 'string' }))).toBe('007')
  })

  test('"007" becomes 7 in an integer column', () => {
    expect(value('007', meta({ kind: 'integer' }))).toBe(7)
  })

  test('a number is refused for a text column rather than stringified', () => {
    // Accepting it is how a leading zero disappears: by the time `7` arrives
    // the `007` the user typed is already gone.
    expect(value(7, meta({ kind: 'string' }))).toBe('!type')
  })

  test('"1.5" is not a whole number', () => {
    expect(value('1.5', meta({ kind: 'integer' }))).toBe('!not_integer')
    expect(value(1.5, meta({ kind: 'integer' }))).toBe('!not_integer')
    expect(value('1.5', meta({ kind: 'number' }))).toBe(1.5)
  })

  test('an integer beyond the safe range is refused, not silently rounded', () => {
    expect(value('9007199254740993', meta({ kind: 'integer' }))).toBe(
      '!not_integer',
    )
    expect(value('9007199254740993', meta({ kind: 'bigint' }))).toBe(
      9007199254740993n,
    )
    // In range, a bigint column still binds an ordinary number.
    expect(value('42', meta({ kind: 'bigint' }))).toBe(42)
  })

  test('NaN and Infinity are not numbers', () => {
    expect(value(Number.NaN, meta({ kind: 'number' }))).toBe('!not_finite')
    expect(value(Number.POSITIVE_INFINITY, meta({ kind: 'number' }))).toBe(
      '!not_finite',
    )
    expect(value('  ', meta({ kind: 'number' }))).toBe('!not_finite')
  })
})

describe('booleans, enums, lengths, json, dates and blobs', () => {
  test('the spellings a CSV actually contains', () => {
    const b = meta({ kind: 'boolean' })
    expect(value('true', b)).toBe(true)
    expect(value('T', b)).toBe(true)
    expect(value('yes', b)).toBe(true)
    expect(value('0', b)).toBe(false)
    expect(value(1, b)).toBe(true)
    expect(value('maybe', b)).toBe('!bad_boolean')
    expect(value(2, b)).toBe('!bad_boolean')
  })

  test('an enum refuses a member it does not have', () => {
    const status = meta({ kind: 'string', enum: ['draft', 'published'] })
    expect(value('draft', status)).toBe('draft')
    expect(value('DRAFT', status)).toBe('!not_in_enum')
  })

  test('a sized text column refuses an over-long value', () => {
    expect(value('abcd', meta({ kind: 'string', length: 3 }))).toBe('!too_long')
    expect(value('abc', meta({ kind: 'string', length: 3 }))).toBe('abc')
  })

  test('json takes text or a value, and refuses text that is not json', () => {
    const j = meta({ kind: 'json' })
    expect(value('{"a":1}', j)).toBe('{"a":1}')
    expect(value({ a: 1 }, j)).toBe('{"a":1}')
    expect(value('{oops', j)).toBe('!bad_json')
  })

  test('a date column takes ISO text or epoch milliseconds', () => {
    const d = meta({ kind: 'date' })
    expect(value('2026-08-13T00:00:00Z', d)).toEqual(
      new Date('2026-08-13T00:00:00Z'),
    )
    expect(value(0, d)).toEqual(new Date(0))
    expect(value('not a date', d)).toBe('!bad_date')
  })

  test('a buffer column takes base64 and refuses anything else', () => {
    const b = meta({ kind: 'buffer' })
    expect(value('aGk=', b)).toEqual(new Uint8Array([104, 105]))
    expect(value('not base64!!', b)).toBe('!bad_base64')
  })
})

describe('the helpers the endpoints lean on', () => {
  test('json and buffer are the two kinds expect cannot compare', () => {
    expect(comparableKind('json')).toBe(false)
    expect(comparableKind('buffer')).toBe(false)
    expect(comparableKind('string')).toBe(true)
    expect(comparableKind('date')).toBe(true)
  })

  test('a column may be omitted from an insert only if the database fills it', () => {
    expect(omittableOnInsert(meta({ autoIncrement: true }))).toBe(true)
    expect(omittableOnInsert(meta({ hasDefault: true }))).toBe(true)
    expect(omittableOnInsert(meta({ nullable: true }))).toBe(true)
    expect(omittableOnInsert(meta())).toBe(false)
  })

  test('sameValue is loose across the wire, but null and "" stay distinct', () => {
    expect(sameValue(1, '1')).toBe(true)
    expect(sameValue(true, 1)).toBe(true)
    expect(sameValue(null, undefined)).toBe(true)
    expect(sameValue(null, '')).toBe(false)
    expect(sameValue('', 0)).toBe(false)
    expect(sameValue(new Date(0), '1970-01-01T00:00:00.000Z')).toBe(true)
  })
})
