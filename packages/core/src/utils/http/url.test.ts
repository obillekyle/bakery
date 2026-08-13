import { describe, expect, test } from 'bun:test'
import { parsedUrl } from './url'

describe('parsedUrl', () => {
  test('parses the request URL', () => {
    const req = new Request('http://localhost:3000/a/b?x=1&y=2#frag')
    const url = parsedUrl(req)

    expect(url).toBeInstanceOf(URL)
    expect(url.href).toBe('http://localhost:3000/a/b?x=1&y=2#frag')
    expect(url.pathname).toBe('/a/b')
    expect(url.searchParams.get('x')).toBe('1')
  })

  test('returns the SAME object on a second call for the same request', () => {
    // The assertion that matters. A broken memo still returns a *correct* URL,
    // so a value-only test cannot see the regression — only identity can.
    const req = new Request('http://localhost/one?a=1')

    const first = parsedUrl(req)
    const second = parsedUrl(req)
    const third = parsedUrl(req)

    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  test('different requests get different objects', () => {
    // Including two requests for the identical URL: the memo is keyed on the
    // Request, not on the string, so these must not be shared.
    const a = new Request('http://localhost/same')
    const b = new Request('http://localhost/same')
    const c = new Request('http://localhost/other')

    expect(parsedUrl(a)).not.toBe(parsedUrl(b))
    expect(parsedUrl(a)).not.toBe(parsedUrl(c))
    expect(parsedUrl(a).href).toBe(parsedUrl(b).href)
  })

  test('does not mutate the request', () => {
    // The point of the WeakMap over the `(req as any).__parsedUrl` property it
    // replaces: a caller's Request goes in and comes back untouched.
    const req = new Request('http://localhost/x')
    const before = Reflect.ownKeys(req).length

    parsedUrl(req)

    expect('__parsedUrl' in (req as object)).toBe(false)
    expect(Reflect.ownKeys(req).length).toBe(before)
  })

  test('handles the shapes the router actually sees', () => {
    // An empty query, an encoded segment, and a bare origin — the memo must not
    // change what `new URL` would have produced.
    for (const href of [
      'http://localhost/',
      'http://localhost/api/_analytics/stats?timescale=1m',
      'https://example.com:8443/a%20b/c',
      'http://localhost/?',
    ]) {
      const req = new Request(href)
      expect(parsedUrl(req).href).toBe(new URL(href).href)
      expect(parsedUrl(req)).toBe(parsedUrl(req))
    }
  })
})
