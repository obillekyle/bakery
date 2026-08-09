import { describe, expect, test } from 'bun:test'
import { checkCsrf, checkSameOrigin, checkWebSocketOrigin } from './csrf'

const url = new URL('https://app.example/api/admin/students')

function req(method: string, headers: Record<string, string> = {}) {
  return new Request(url.href, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
  })
}

describe('checkCsrf', () => {
  test('allows safe methods regardless of origin', () => {
    expect(
      checkCsrf(req('GET', { origin: 'https://evil.example' }), url),
    ).toBeNull()
    expect(
      checkCsrf(req('HEAD', { origin: 'https://evil.example' }), url),
    ).toBeNull()
  })

  test('rejects a cross-origin POST', () => {
    // The classic attack: a cross-site <form> POST is CORS-simple, so it is
    // sent with the victim's SameSite=Lax cookie attached.
    const reason = checkCsrf(
      req('POST', {
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      }),
      url,
    )
    expect(reason).toContain('cross-origin')
  })

  test('rejects a cross-site POST signalled only by Sec-Fetch-Site', () => {
    const reason = checkCsrf(
      req('POST', { 'sec-fetch-site': 'cross-site' }),
      url,
    )
    expect(reason).toContain('cross-site')
  })

  test('allows a same-origin POST', () => {
    expect(
      checkCsrf(
        req('POST', { origin: url.origin, 'sec-fetch-site': 'same-origin' }),
        url,
      ),
    ).toBeNull()
  })

  test('allows a POST with no origin headers (curl, server-to-server)', () => {
    expect(checkCsrf(req('POST'), url)).toBeNull()
  })

  test('allows same-site and none', () => {
    expect(
      checkCsrf(req('POST', { 'sec-fetch-site': 'same-site' }), url),
    ).toBeNull()
    expect(checkCsrf(req('POST', { 'sec-fetch-site': 'none' }), url)).toBeNull()
  })

  test('rejects DELETE and PUT from another origin', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect(
        checkCsrf(req(method, { origin: 'https://evil.example' }), url),
      ).toContain('cross-origin')
    }
  })
})

describe('checkSameOrigin', () => {
  test('ignores the literal "null" origin rather than comparing it', () => {
    expect(checkSameOrigin(req('POST', { origin: 'null' }), url)).toBeNull()
  })

  test('checks origin even for safe methods', () => {
    expect(
      checkSameOrigin(req('GET', { origin: 'https://evil.example' }), url),
    ).toContain('cross-origin')
  })
})

/**
 * The guard `upgradeWebsocket` calls.
 *
 * A handshake is a GET, so `checkCsrf` waves it through by definition, and
 * `checkSameOrigin`'s tolerance of `Origin: null` is a hole a sandboxed iframe
 * fits through. Hence a third, stricter guard rather than a reuse.
 */
describe('checkWebSocketOrigin', () => {
  const wsUrl = new URL('http://localhost:3000/_livereload')
  const ws = (headers: Record<string, string> = {}) =>
    new Request(wsUrl.href, { headers })

  test('rejects a handshake from another origin', () => {
    // The reported exploit: any page the developer visits could open
    // /_livereload and subscribe to the live server log.
    const reason = checkWebSocketOrigin(
      ws({ origin: 'https://evil.example' }),
      wsUrl,
    )
    expect(reason).toContain('cross-origin')
    expect(reason).toContain('evil.example')
  })

  test("allows the browser's own origin", () => {
    expect(
      checkWebSocketOrigin(ws({ origin: 'http://localhost:3000' }), wsUrl),
    ).toBeNull()
  })

  test('rejects an opaque origin, unlike the HTTP guard', () => {
    // <iframe sandbox srcdoc="..."> on the attacker's page sends this.
    expect(checkWebSocketOrigin(ws({ origin: 'null' }), wsUrl)).toContain(
      'cross-origin',
    )
    expect(checkSameOrigin(ws({ origin: 'null' }), wsUrl)).toBeNull()
  })

  test('rejects an unparseable origin rather than falling through', () => {
    expect(checkWebSocketOrigin(ws({ origin: 'not-a-url' }), wsUrl)).toContain(
      'cross-origin',
    )
  })

  test('allows a scheme or port rewritten by a TLS-terminating proxy', () => {
    // The browser reports https://app.example; the request reaching Bun looks
    // like http://app.example:3000. Comparing full origins would refuse every
    // socket in that entirely ordinary deployment.
    const proxied = new URL('http://app.example:3000/ws')
    const proxiedReq = new Request(proxied.href, {
      headers: { origin: 'https://app.example' },
    })
    expect(checkWebSocketOrigin(proxiedReq, proxied)).toBeNull()
  })

  test('still rejects a different host behind that same proxy', () => {
    const proxied = new URL('http://app.example:3000/ws')
    const evilReq = new Request(proxied.href, {
      headers: { origin: 'https://evil.example' },
    })
    expect(checkWebSocketOrigin(evilReq, proxied)).toContain('cross-origin')
  })

  test('allows an absent Origin, which is a non-browser client', () => {
    // Decided, not overlooked: a browser never omits Origin on a handshake, so
    // its absence means a peer that could equally have forged the header.
    expect(checkWebSocketOrigin(ws(), wsUrl)).toBeNull()
  })

  test('the reason it logs cannot carry control characters', () => {
    // This string is handed to serveLog, and the logger renders one record per
    // line. Bun rejects CR and LF in a header value, but every other C0
    // control goes straight through -- verified for TAB, U+0001 and DEL below
    // -- and a terminal renders several of those as line breaks.
    const tab = String.fromCharCode(9)
    const ctl = String.fromCharCode(1)
    const del = String.fromCharCode(127)
    const reason = checkWebSocketOrigin(
      ws({ origin: `https://evil.example${tab}${ctl}${del}[E] forged` }),
      wsUrl,
    )
    expect(reason).toContain('cross-origin')
    expect(/[^\x20-\x7e]/.test(reason as string)).toBe(false)
  })

  test('truncates an over-long origin', () => {
    const long = `https://${'a'.repeat(400)}.example`
    const reason = checkWebSocketOrigin(ws({ origin: long }), wsUrl) as string
    expect(reason.length).toBeLessThan(200)
  })
})
