import { describe, expect, test } from 'bun:test'

describe('match prototype-key safety', () => {
  test('does not resolve inherited Object.prototype members', async () => {
    const { match } = await import('./match')
    // `value in cases` used to find (and invoke) Object.prototype.toString.
    for (const key of [
      'toString',
      'constructor',
      'valueOf',
      'hasOwnProperty',
    ]) {
      expect(match(key, { a: 1 } as any)).toBeUndefined()
    }
  })

  test('still resolves own keys and the default branch', async () => {
    const { match } = await import('./match')
    expect(match('a', { a: 1 } as any)).toBe(1)
    expect(match('toString', { [match.default]: 'fallback' } as any)).toBe(
      'fallback',
    )
  })
})

import { match } from './match'

describe('match', () => {
  describe('string key matching', () => {
    test('matches exact string keys', () => {
      const result = match('a', {
        a: 1,
        b: 2,
        c: 3,
      })
      expect(result).toBe(1)
    })

    test('returns undefined for unmatched key', () => {
      const result = match('x', {
        a: 1,
        b: 2,
      })
      expect(result).toBeUndefined()
    })

    test('calls function handler with value', () => {
      const result = match('foo', {
        foo: v => `matched:${v}`,
        bar: 'nope',
      })
      expect(result).toBe('matched:foo')
    })

    test('returns raw value when handler is not a function', () => {
      const result = match('bar', {
        foo: 1,
        bar: 42,
      })
      expect(result).toBe(42)
    })
  })

  describe('default fallback', () => {
    test('uses default when key not found', () => {
      const result = match('zz', {
        a: 1,
        [match.default]: 99,
      })
      expect(result).toBe(99)
    })

    test('default is callable', () => {
      // Explicit K: inference gets one candidate from `a: 1` and another from
      // the default's string return, and picks neither. The object form cannot
      // express heterogeneous case values without being told the union — a
      // limitation of the Match type, not of the runtime, which handles this.
      const result = match<'zz', string | number>('zz', {
        a: 1,
        [match.default]: (v: any) => `fallback:${v}`,
      })
      expect(result).toBe('fallback:zz')
    })
  })

  describe('array case matching', () => {
    test('matches predicate function', () => {
      const result = match(5, [
        [(v: number) => v < 3, 'small'],
        [(v: number) => v >= 3 && v < 10, 'medium'],
        [(v: number) => v >= 10, 'large'],
      ])
      expect(result).toBe('medium')
    })

    test('matches literal value', () => {
      const result = match('hello', [
        ['hello', 'greeting'],
        ['goodbye', 'farewell'],
      ])
      expect(result).toBe('greeting')
    })

    test('calls result function when predicate matches', () => {
      const result = match(42, [[42, (v: number) => v * 2]])
      expect(result).toBe(84)
    })

    test('uses match.default as predicate', () => {
      const result = match('anything', [
        ['nope', 'no'],
        [match, 'yes'],
      ])
      expect(result).toBe('yes')
    })

    test('returns undefined when no predicate matches', () => {
      const result = match(99, [[(v: number) => v < 10, 'small']]) as any
      expect(result).toBeUndefined()
    })
  })

  describe('edge cases', () => {
    test('returns undefined for non-string, non-array cases', () => {
      const result = match(42, { a: 1 } as any)
      expect(result).toBeUndefined()
    })
  })
})
