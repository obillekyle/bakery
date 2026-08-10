import { describe, expect, test } from 'bun:test'
import {
  applyCors,
  type CorsOptions,
  corsHeaders,
  preflightResponse,
  resolveOrigin,
} from './cors'

const req = (method: string, headers: Record<string, string> = {}): Request =>
  new Request('http://localhost/api/x', { method, headers })

describe('resolveOrigin', () => {
  test('an exact string matches only itself', () => {
    const o: CorsOptions = { origin: 'https://app.example' }
    expect(resolveOrigin(o, 'https://app.example')).toBe('https://app.example')
    expect(resolveOrigin(o, 'https://evil.example')).toBeNull()
    // A missing Origin is not a cross-origin request; nothing to allow.
    expect(resolveOrigin(o, null)).toBeNull()
  })

  test('a list matches any member, and nothing else', () => {
    const o: CorsOptions = {
      origin: ['https://a.example', 'https://b.example'],
    }
    expect(resolveOrigin(o, 'https://b.example')).toBe('https://b.example')
    expect(resolveOrigin(o, 'https://c.example')).toBeNull()
  })

  test('a function decides, and may rewrite', () => {
    const o: CorsOptions = {
      origin: origin => (origin.endsWith('.trusted') ? origin : null),
    }
    expect(resolveOrigin(o, 'https://x.trusted')).toBe('https://x.trusted')
    expect(resolveOrigin(o, 'https://x.other')).toBeNull()
  })

  test('a wildcard needs no request origin', () => {
    expect(resolveOrigin({ origin: '*' }, null)).toBe('*')
  })

  test('wildcard + credentials is refused, not downgraded', () => {
    // The browser rejects this pairing outright. Honouring it would leave the
    // server believing it allowed a call the client could never make; echoing
    // the origin instead would silently widen what the app asked for. Denying
    // makes the misconfiguration visible.
    expect(
      resolveOrigin({ origin: '*', credentials: true }, 'https://app.example'),
    ).toBeNull()
  })
})

describe('corsHeaders', () => {
  test('a denied origin produces nothing at all', () => {
    expect(corsHeaders({ origin: 'https://a' }, 'https://b')).toBeNull()
  })

  test('Vary: Origin is set whenever the value is origin-dependent', () => {
    // Without it a shared cache can hand one origin the response computed for
    // another — the classic CORS cache-poisoning shape.
    const h = corsHeaders({ origin: ['https://a'] }, 'https://a')
    expect(h?.Vary).toBe('Origin')
  })

  test('a wildcard needs no Vary, because nothing varies', () => {
    expect(corsHeaders({ origin: '*' }, 'https://a')?.Vary).toBeUndefined()
  })

  test('credentials and exposed headers are opt-in', () => {
    const plain = corsHeaders({ origin: '*' }, null)
    expect(plain?.['Access-Control-Allow-Credentials']).toBeUndefined()
    expect(plain?.['Access-Control-Expose-Headers']).toBeUndefined()

    const full = corsHeaders(
      { origin: 'https://a', credentials: true, exposeHeaders: ['X-Total'] },
      'https://a',
    )
    expect(full?.['Access-Control-Allow-Credentials']).toBe('true')
    expect(full?.['Access-Control-Expose-Headers']).toBe('X-Total')
  })
})

describe('preflightResponse', () => {
  const o: CorsOptions = { origin: 'https://a', maxAge: 600 }

  test('only OPTIONS *with* Access-Control-Request-Method is a preflight', () => {
    // A bare OPTIONS is an ordinary request. Treating it as a preflight would
    // shadow an app's own OPTIONS route, which it could never then serve.
    expect(preflightResponse(o, req('GET'))).toBeNull()
    expect(preflightResponse(o, req('OPTIONS'))).toBeNull()
    expect(
      preflightResponse(
        o,
        req('OPTIONS', {
          Origin: 'https://a',
          'Access-Control-Request-Method': 'POST',
        }),
      ),
    ).toBeInstanceOf(Response)
  })

  test('answers 204 with the negotiated headers', () => {
    const res = preflightResponse(
      o,
      req('OPTIONS', {
        Origin: 'https://a',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-custom, content-type',
      }),
    )!
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://a')
    expect(res.headers.get('Access-Control-Max-Age')).toBe('600')
    // Echoed rather than enumerated: listing every header a client might send
    // is a list nobody maintains, and being wrong fails only in the browser.
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe(
      'x-custom, content-type',
    )
  })

  test('an explicit allowHeaders wins over the echo', () => {
    const res = preflightResponse(
      { origin: '*', allowHeaders: ['content-type'] },
      req('OPTIONS', {
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-sneaky',
      }),
    )!
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('content-type')
  })

  test('a denied origin still gets 204, without permission headers', () => {
    const res = preflightResponse(
      { origin: 'https://a' },
      req('OPTIONS', {
        Origin: 'https://evil',
        'Access-Control-Request-Method': 'POST',
      }),
    )!
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('applyCors', () => {
  test('appends to an existing response without replacing it', () => {
    const res = new Response('body', {
      status: 201,
      headers: { 'Content-Type': 'text/plain' },
    })
    const out = applyCors({ origin: '*' }, req('GET'), res)

    expect(out.status).toBe(201)
    expect(out.headers.get('Content-Type')).toBe('text/plain')
    expect(out.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })

  test('a denied origin leaves the response untouched', () => {
    const res = new Response('body')
    const out = applyCors(
      { origin: 'https://a' },
      req('GET', { Origin: 'https://b' }),
      res,
    )
    expect(out.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  test('an existing Vary is extended, not overwritten', () => {
    // ETag negotiation sets Vary too. Whichever ran second must not drop the
    // other's value, or a cache keys on the wrong thing.
    const res = new Response('body', {
      headers: { Vary: 'Accept-Encoding' },
    })
    const out = applyCors(
      { origin: ['https://a'] },
      req('GET', { Origin: 'https://a' }),
      res,
    )
    const vary = out.headers.get('Vary') ?? ''
    expect(vary).toContain('Accept-Encoding')
    expect(vary).toContain('Origin')
  })

  test('is idempotent on Vary', () => {
    const res = new Response('body', { headers: { Vary: 'Origin' } })
    const out = applyCors(
      { origin: ['https://a'] },
      req('GET', { Origin: 'https://a' }),
      res,
    )
    expect(out.headers.get('Vary')).toBe('Origin')
  })
})
