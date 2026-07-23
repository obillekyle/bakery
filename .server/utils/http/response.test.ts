import { describe, test, expect } from 'bun:test'
import { response, redirect } from './response'

describe('response()', () => {
  test('creates basic Response', () => {
    const res = response('hello')
    expect(res).toBeInstanceOf(Response)
  })
})

describe('response.json', () => {
  test('creates JSON response', () => {
    const res = response.json(200, 'OK', { id: 1 })
    expect(res.status).toBe(200)
    expect(res.message).toBe('OK')
    expect(res.data).toEqual({ id: 1 })
  })
})

describe('response.json.success', () => {
  test('creates success response with 200', () => {
    const res = (response.json as any).success('done', { ok: true })
    expect(res.status).toBe(200)
    expect(res.message).toBe('done')
    expect(res.data).toEqual({ ok: true })
  })

  test('allows custom status', () => {
    const res = (response.json as any).success('created', {}, 201)
    expect(res.status).toBe(201)
  })
})

describe('response.json.error', () => {
  test('creates error with 404 default', () => {
    const res = (response.json as any).error()
    expect(res.status).toBe(404)
    expect(res.message).toBe('Error')
  })

  test('allows custom status and message', () => {
    const res = (response.json as any).error(500, 'Server Error')
    expect(res.status).toBe(500)
    expect(res.message).toBe('Server Error')
  })
})

describe('response.html', () => {
  test('creates HTML response', () => {
    const res = response.html('<h1>Hello</h1>')
    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })
})

describe('response.text', () => {
  test('creates text response', () => {
    const res = response.text('hello')
    expect(res).toBeInstanceOf(Response)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
  })
})

describe('response.error', () => {
  test('creates error response', () => {
    const res = response.error('Not Found', 404)
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(404)
    expect(res.statusText).toBe('Not Found')
  })

  test('handles Error object', () => {
    const res = response.error(new Error('fail'), 500)
    expect(res.status).toBe(500)
    expect(res.statusText).toBe('fail')
  })
})

describe('response.type', () => {
  test('creates response with custom content type', () => {
    const res = response.type('data', 'application/xml')
    expect(res.headers.get('Content-Type')).toBe('application/xml')
  })
})

describe('redirect', () => {
  test('creates redirect response', () => {
    const res = redirect('http://example.com')
    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(302)
  })
})
