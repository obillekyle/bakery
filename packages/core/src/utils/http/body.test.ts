import { describe, expect, test } from 'bun:test'
import { processBody } from './body'

describe('processBody', () => {
  test('extracts query params from GET request', async () => {
    const req = new Request('http://localhost/?name=kyle&age=30')
    const body = await processBody(req)
    expect(body.name).toBe('kyle')
    expect(body.age).toBe('30')
  })

  test('parses JSON body from POST', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'test', count: 5 }),
    })
    const body = await processBody(req)
    expect(body.name).toBe('test')
    expect(body.count).toBe(5)
  })

  test('parses form-urlencoded body', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'key=value&foo=bar',
    })
    const body = await processBody(req)
    expect(body.key).toBe('value')
    expect(body.foo).toBe('bar')
  })

  test('returns empty object on parse failure', async () => {
    const req = new Request('http://localhost/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    })
    const body = await processBody(req)
    expect(typeof body).toBe('object')
  })
})
