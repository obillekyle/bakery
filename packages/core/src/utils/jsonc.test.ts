import { describe, expect, test } from 'bun:test'
import { parseJSONC } from './jsonc'

describe('parseJSONC', () => {
  test('parses valid JSON', () => {
    expect(parseJSONC('{"a": 1}')).toEqual({ a: 1 })
  })

  test('strips single-line comments', () => {
    expect(parseJSONC('// comment\n{"a": 1}')).toEqual({ a: 1 })
  })

  test('strips multi-line comments', () => {
    expect(parseJSONC('/* block */ {"a": 1}')).toEqual({ a: 1 })
  })

  test('removes trailing commas', () => {
    expect(parseJSONC('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 })
    expect(parseJSONC('[1, 2, 3,]')).toEqual([1, 2, 3])
  })

  test('handles empty input', () => {
    expect(parseJSONC('')).toBeNull()
    expect(parseJSONC('   ')).toBeNull()
  })

  test('handles nested objects with comments', () => {
    const input = `{
      // top-level comment
      "server": {
        "port": 3000, // inline comment
        "host": "localhost",
      },
      /* multi
         line */
      "debug": true,
    }`
    expect(parseJSONC(input)).toEqual({
      server: { port: 3000, host: 'localhost' },
      debug: true,
    })
  })

  test('handles string values containing comment-like characters', () => {
    expect(parseJSONC('{"url": "http://example.com"}')).toEqual({
      url: 'http://example.com',
    })
  })
})
