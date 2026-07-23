import { describe, test, expect } from 'bun:test'
import { ETag } from './etag'

describe('ETag', () => {
  describe('fromText', () => {
    test('returns a weak etag string', () => {
      const etag = ETag.fromText('hello world')
      expect(etag).toMatch(/^W\/".+"$/)
    })

    test('same text produces same etag', () => {
      expect(ETag.fromText('test')).toBe(ETag.fromText('test'))
    })

    test('different text produces different etag', () => {
      expect(ETag.fromText('a')).not.toBe(ETag.fromText('b'))
    })
  })

  describe('check', () => {
    test('returns 304 Response when etag matches', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText('hello') },
      })
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).not.toBeNull()
      expect(res!.status).toBe(304)
    })

    test('returns null when etag does not match', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText('different') },
      })
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).toBeNull()
    })

    test('returns null when no if-none-match header', () => {
      const req = new Request('http://localhost/')
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).toBeNull()
    })

    test('matches wildcard *', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': '*' },
      })
      const res = ETag.check(req, ETag.fromText('anything'))
      expect(res).not.toBeNull()
      expect(res!.status).toBe(304)
    })
  })

  describe('sendResponse', () => {
    test('returns response unchanged when no ETag header', () => {
      const req = new Request('http://localhost/')
      const res = new Response('body')
      const result = ETag.sendResponse(req, res)
      expect(result.status).toBe(200)
    })

    test('returns 304 when client etag matches', () => {
      const etag = ETag.fromText('content')
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': etag },
      })
      const res = new Response('body', { headers: { ETag: etag } })
      const result = ETag.sendResponse(req, res)
      expect(result.status).toBe(304)
    })
  })

  describe('sendText', () => {
    test('returns text response with ETag header', () => {
      const res = ETag.sendText('hello')
      expect(res.headers.get('ETag')).toBeTruthy()
      expect(res.headers.get('Content-Type')).toContain('text/plain')
    })

    test('returns 304 when etag matches', () => {
      const text = 'hello'
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText(text) },
      })
      const res = ETag.sendText(text, req)
      expect(res.status).toBe(304)
    })
  })
})
