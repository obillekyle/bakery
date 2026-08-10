import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __resetTestConfig, __setTestConfig, initConfig } from '../core/config'
import { handleRequest, processResponse } from '../router'

/**
 * CORS through the real request path, not the helpers in isolation.
 *
 * The unit tests in `utils/http/cors.test.ts` cover the header algebra. These
 * cover the two wiring questions they cannot: that a preflight is answered
 * *before* routing (it names its route in a header, so routing would answer the
 * wrong question), and that the headers reach responses produced by every other
 * handler — which is only true because they are applied in `processResponse`,
 * the single funnel every response passes through.
 */
describe('CORS end to end', () => {
  beforeAll(async () => {
    await initConfig()
    __setTestConfig({
      cors: { origin: 'https://app.example', credentials: true, maxAge: 600 },
    })
  })

  afterAll(() => {
    __resetTestConfig()
  })

  const preflight = () =>
    new Request('http://localhost/api/anything', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://app.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    })

  test('a preflight is answered without routing', async () => {
    // /api/anything does not exist. If this reached the router it would 404;
    // 204 proves the short-circuit fired ahead of resolution.
    const res = (await handleRequest(preflight())) as Response

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example',
    )
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600')
  })

  test('a bare OPTIONS is not treated as a preflight', async () => {
    // No Access-Control-Request-Method, so this is an ordinary request and must
    // fall through — otherwise an app could never serve its own OPTIONS route.
    const res = await handleRequest(
      new Request('http://localhost/api/anything', { method: 'OPTIONS' }),
    )
    // Whatever routing decides, it must not be the 204 preflight answer.
    const status = res instanceof Response ? res.status : 0
    expect(status).not.toBe(204)
  })

  test('headers reach an ordinary response through processResponse', async () => {
    const req = new Request('http://localhost/whatever', {
      headers: { Origin: 'https://app.example' },
    })
    const out = await processResponse(new Response('hello'), req)

    expect(out?.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://app.example',
    )
    expect(out?.headers.get('Access-Control-Allow-Credentials')).toBe('true')
    // Origin-dependent, so a shared cache has to key on it.
    expect(out?.headers.get('Vary')).toContain('Origin')
  })

  test('a disallowed origin gets no permission headers', async () => {
    const req = new Request('http://localhost/whatever', {
      headers: { Origin: 'https://evil.example' },
    })
    const out = await processResponse(new Response('hello'), req)

    expect(out?.headers.get('Access-Control-Allow-Origin')).toBeNull()
    // Still served — CORS governs what the browser lets script read, not
    // whether the server answers.
    expect(out?.status).toBe(200)
  })

  test('with cors unset, no CORS headers appear at all', async () => {
    __setTestConfig({ cors: null })
    const req = new Request('http://localhost/whatever', {
      headers: { Origin: 'https://app.example' },
    })
    const out = await processResponse(new Response('hello'), req)

    expect(out?.headers.get('Access-Control-Allow-Origin')).toBeNull()

    // And a preflight is no longer special.
    const res = await handleRequest(preflight())
    const status = res instanceof Response ? res.status : 0
    expect(status).not.toBe(204)

    __setTestConfig({
      cors: { origin: 'https://app.example', credentials: true, maxAge: 600 },
    })
  })
})
