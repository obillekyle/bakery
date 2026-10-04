import { describe, expect, test } from 'bun:test'
import { ArrayValue, encodePgArray, isArrayValue } from './array-value'

describe('encodePgArray', () => {
  test('quotes every element, so commas, braces and spaces are only text', () => {
    expect(encodePgArray(['a', 'b c', 'd,e', '{f}'])).toBe(
      '{"a","b c","d,e","{f}"}',
    )
  })

  test('escapes backslashes and double quotes', () => {
    const backslash = String.fromCharCode(92)
    expect(encodePgArray([`say "hi"`, `back${backslash}slash`])).toBe(
      `{"say ${backslash}"hi${backslash}"","back${backslash}${backslash}slash"}`,
    )
  })

  test('NULL is bare, and an empty array is braces', () => {
    expect(encodePgArray(['x', null, undefined])).toBe('{"x",NULL,NULL}')
    expect(encodePgArray([])).toBe('{}')
  })

  test('numbers, booleans, dates, objects and nested arrays', () => {
    expect(encodePgArray([1, 2.5, 10n])).toBe('{"1","2.5","10"}')
    expect(encodePgArray([true, false])).toBe('{"true","false"}')
    expect(encodePgArray([new Date('2026-10-04T00:00:00Z')])).toBe(
      '{"2026-10-04T00:00:00.000Z"}',
    )
    expect(encodePgArray([{ a: 1 }])).toBe(
      `{"{${String.fromCharCode(92)}"a${String.fromCharCode(92)}":1}"}`,
    )
    expect(encodePgArray([[1, 2], [3]])).toBe('{{"1","2"},{"3"}}')
  })

  test('isArrayValue tells the wrapper from a plain array', () => {
    expect(isArrayValue(new ArrayValue([1]))).toBe(true)
    expect(isArrayValue([1])).toBe(false)
  })
})
