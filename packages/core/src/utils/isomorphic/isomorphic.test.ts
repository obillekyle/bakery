import { describe, expect, test } from 'bun:test'
import {
  Case as CommonCase,
  Math2 as CommonMath2,
  Try as CommonTry,
  is as commonIs,
  match as commonMatch,
  throws as commonThrows,
} from '../common'
import { Case } from './case'
import { escapeHtml, escapeScriptJson } from './escape'
import { is } from './is'
import { match } from './match'
import { Math2 } from './math'
import { throws } from './misc'
import { circularReplacer, safeStringify } from './stringify'
import { Try } from './try'

describe('single source of truth', () => {
  // If any of these stop being the same reference, a second copy has appeared.
  test('utils/common re-exports the isomorphic implementations', () => {
    expect(commonIs).toBe(is)
    expect(CommonTry).toBe(Try)
    expect(commonMatch).toBe(match)
    expect(CommonCase).toBe(Case)
    expect(CommonMath2).toBe(Math2)
    expect(commonThrows).toBe(throws)
  })
})

describe('is', () => {
  // Arrays counting as objects is load-bearing: router.ts uses is.object() to
  // decide whether to JSON-encode a response body, and misc.test.ts asserts it.
  test('treats arrays as objects', () => {
    expect(is.object([])).toBe(true)
    expect(is.object({})).toBe(true)
    expect(is.object(null)).toBe(false)
  })

  test('callable form agrees with the method form', () => {
    expect(is(null, 'object')).toBe(is.object(null))
    expect(is([], 'object')).toBe(is.object([]))
    expect(is('x', 'string')).toBe(true)
    expect(is(1n, 'bigint')).toBe(true)
  })
})

describe('stringify', () => {
  test('replacer takes (key, value), not just one parameter', () => {
    // A one-parameter replacer binds to `key`, so the first call ("", data)
    // returns "" and the whole document collapses to '""'.
    expect(JSON.stringify({ a: 1 }, circularReplacer())).toBe('{"a":1}')
    expect(JSON.stringify([1, 2], circularReplacer())).toBe('[1,2]')
  })

  test('substitutes [Circular] instead of throwing', () => {
    const cyclic: any = { name: 'root' }
    cyclic.self = cyclic
    expect(safeStringify(cyclic)).toContain('[Circular]')
  })

  test('extra replacer runs on top of the cycle check', () => {
    const out = JSON.stringify(
      { n: 1 },
      circularReplacer((_k, v) => (typeof v === 'number' ? 'N' : v)),
    )
    expect(out).toBe('{"n":"N"}')
  })

  test('primitives pass through String()', () => {
    expect(safeStringify(42)).toBe('42')
    expect(safeStringify(null)).toBe('null')
  })
})

describe('escape', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    )
  })

  test('nullish input yields an empty string rather than throwing', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
  })

  test('script JSON cannot close the enclosing tag', () => {
    expect(escapeScriptJson({ x: '</script>' })).not.toContain('</script>')
  })

  test('script JSON escapes the JS line terminators', () => {
    const u2028 = String.fromCharCode(0x2028)
    const u2029 = String.fromCharCode(0x2029)
    const out = escapeScriptJson({ a: u2028, b: u2029 })
    expect(out).not.toContain(u2028)
    expect(out).not.toContain(u2029)
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
  })

  test('undefined members serialize as null instead of vanishing', () => {
    expect(escapeScriptJson({ a: undefined })).toBe('{"a":null}')
  })
})
