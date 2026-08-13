import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { ProxyHandler } from './proxy'

/**
 * `ProxyHandler` is the one fetch surface that hands a request to a machine the
 * operator does not control, and it sits at priority 95 — above everything
 * except middleware. Two properties carry the risk:
 *
 *  1. **It must not forward the caller's credentials.** `cookie` and
 *     `authorization` are the session and the bearer token for *this* origin;
 *     a proxy prefix pointing at any third party would otherwise hand them
 *     over on every request, and nothing downstream could undo it. This file
 *     existed with zero coverage.
 *  2. **The target has to be assembled correctly**, including the query string
 *     — dropped once already, restored in `cb5a379`.
 *
 * Both are asserted against a real loopback upstream rather than a stubbed
 * `fetch`. The point of the credential test is what *arrives* at the far end,
 * and only a server can answer that: a stub would pin the `Request` the
 * handler built and still miss anything `fetch` itself re-attaches (`host` is
 * exactly such a header — see below). `Bun.serve` outside `cli/worker.ts` is
 * fine here; the "one Bun.serve" convention check excludes test files.
 */

/** What the upstream saw on its most recent request. */
type Seen = {
  path: string
  search: string
  method: string
  headers: Record<string, string>
  body: string | null
}

let seen: Seen | null = null

const GZIP_BODY = 'compressed-upstream-body'

/** A path this handler will never be asked for, used for the negative cases. */
const UNMATCHED = '/definitely-not-proxied/thing'

/**
 * Records what it was sent and answers. Declared as a function so the server
 * handle can be typed by inference — `Bun.Server` is generic over its
 * websocket data and cannot be written bare.
 */
function startUpstream() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen = {
        path: url.pathname,
        search: url.search,
        method: req.method,
        headers: Object.fromEntries(req.headers),
        body:
          req.method === 'GET' || req.method === 'HEAD'
            ? null
            : await req.text(),
      }

      if (url.pathname.endsWith('/gzipped')) {
        // A *genuinely* gzipped body. Claiming the encoding without doing it
        // makes Bun's fetch throw ZlibError before the handler ever sees a
        // response, so the header-stripping case cannot be faked.
        const gz = Bun.gzipSync(Buffer.from(GZIP_BODY))
        return new Response(gz, {
          status: 201,
          headers: {
            'content-encoding': 'gzip',
            'content-length': String(gz.byteLength),
            'x-upstream': 'yes',
          },
        })
      }

      return new Response('upstream-body', {
        status: 200,
        headers: { 'x-upstream': 'yes' },
      })
    },
  })
}

let upstream: ReturnType<typeof startUpstream>
let port = 0

describe('ProxyHandler', () => {
  beforeAll(async () => {
    await initConfig()

    upstream = startUpstream()
    // `port: 0` asks the OS for a free one, so the bound port is only known
    // after the fact — and is optional on the type, since a unix-socket server
    // has none. Nothing below means anything without it.
    if (!upstream.port) throw new Error('upstream bound no port')
    port = upstream.port

    __setTestConfig({
      proxy: {
        '/one': `http://127.0.0.1:${port}/up`,
        // Same upstream, target written with a trailing slash — the branch
        // that slices it back off.
        '/two': `http://127.0.0.1:${port}/up/`,
        // Deliberately overlapping, `/pre` declared first. See the ordering
        // test: iteration is insertion order and the loop `break`s.
        '/pre': `http://127.0.0.1:${port}/first`,
        '/pre/deep': `http://127.0.0.1:${port}/second`,
        // Port 1 refuses immediately; nothing listens there.
        '/dead': 'http://127.0.0.1:1/nowhere',
      },
    })
  })

  afterAll(() => {
    __resetTestConfig()
    upstream?.stop(true)
  })

  const get = (path: string, headers?: Record<string, string>) =>
    ProxyHandler.handle(
      path,
      new Request(`http://caller.example${path}`, { headers }),
    )

  test('canHandle claims only the configured prefixes', () => {
    expect(ProxyHandler.canHandle('/one')).toBe(true)
    expect(ProxyHandler.canHandle('/one/deeper/still')).toBe(true)
    expect(ProxyHandler.canHandle(UNMATCHED)).toBe(false)
    expect(ProxyHandler.canHandle('/')).toBe(false)
  })

  /**
   * The assertion this file exists for.
   *
   * `cookie` is the caller's session for *our* origin and `authorization` is
   * their bearer token; a proxy prefix aimed at any third party would post
   * both to it on every single request, with no way for the user to know and
   * no way to revoke after the fact. `sec-fetch-site` goes too — it describes
   * the browser's relationship to *us*, and forwarding it invites the upstream
   * to treat a cross-site request as same-site.
   *
   * Asserted at the upstream, not on the `Request` object, because that is the
   * only place the question is really answered.
   */
  test('caller credentials never reach the upstream', async () => {
    await get('/one/resource', {
      cookie: 'session=SUPER_SECRET',
      authorization: 'Bearer SUPER_SECRET_TOKEN',
      'sec-fetch-site': 'same-origin',
    })

    expect(seen).not.toBeNull()
    const received = seen as Seen

    expect(received.headers.cookie).toBeUndefined()
    expect(received.headers.authorization).toBeUndefined()
    expect(received.headers['sec-fetch-site']).toBeUndefined()

    // Belt and braces: not merely absent under those names, but absent from
    // the request entirely — a rename or a fold into some other header would
    // leak just as badly and would pass the three checks above.
    const all = JSON.stringify(received.headers)
    expect(all).not.toContain('SUPER_SECRET')
    expect(all).not.toContain('SUPER_SECRET_TOKEN')
  })

  /**
   * `host` is the one that cannot be asserted as "absent": `fetch` always sets
   * it from the URL it is dialling. The property is that the value describes
   * the *target*, not us — the handler deletes ours so fetch derives a fresh
   * one, and an upstream doing virtual-host routing therefore sees itself
   * rather than `caller.example`.
   */
  test('host is re-derived from the target, not forwarded', async () => {
    await get('/one/resource', { host: 'caller.example' })

    expect((seen as Seen).headers.host).toBe(`127.0.0.1:${port}`)
  })

  /**
   * The other half of the stripping claim, and the half that makes it a
   * *targeted* strip rather than a blanket wipe. A proxy that dropped every
   * header would be safe and useless — content negotiation, tracing headers
   * and the user agent all have to survive.
   */
  test('every other header survives', async () => {
    await get('/one/resource', {
      cookie: 'session=SUPER_SECRET',
      'x-request-id': 'abc-123',
      'accept-language': 'en-GB',
      'user-agent': 'bakery-proxy-test/1',
    })

    const received = seen as Seen
    expect(received.headers['x-request-id']).toBe('abc-123')
    expect(received.headers['accept-language']).toBe('en-GB')
    expect(received.headers['user-agent']).toBe('bakery-proxy-test/1')
  })

  /**
   * Regression for `cb5a379`. The query string is not part of `path` — the
   * router hands handlers a pathname — so it has to be read back off the
   * request, and it was once simply lost. A proxied API with pagination or a
   * search term silently returned the unfiltered first page.
   */
  test('the query string is carried through', async () => {
    await ProxyHandler.handle(
      '/one/search',
      new Request('http://caller.example/one/search?q=cake&page=2'),
    )

    const received = seen as Seen
    expect(received.path).toBe('/up/search')
    expect(received.search).toBe('?q=cake&page=2')
  })

  test('the prefix is replaced by the target, not appended to it', async () => {
    await get('/one/nested/resource.json')
    expect((seen as Seen).path).toBe('/up/nested/resource.json')
  })

  test('a bare prefix hits the target root with a separator', async () => {
    // `trailingPath` is empty here, which is the branch that inserts the `/`.
    await get('/one')
    expect((seen as Seen).path).toBe('/up/')
  })

  test('a trailing slash on the target is not doubled', async () => {
    await get('/two/resource')
    expect((seen as Seen).path).toBe('/up/resource')

    await get('/two')
    expect((seen as Seen).path).toBe('/up/')
  })

  /**
   * Pinning current behaviour, which is **first match in declaration order**,
   * not longest match: the loop `break`s on the first `startsWith` hit and
   * `Object.entries` is insertion order. So `/pre/deep/x` is served by `/pre`
   * and the more specific entry never runs.
   *
   * Recorded here rather than argued about, so that if longest-prefix-wins is
   * ever adopted it is a deliberate change with a test to update, instead of
   * an accident nobody notices.
   */
  test('the first matching prefix wins, in declaration order', async () => {
    await get('/pre/deep/x')
    expect((seen as Seen).path).toBe('/first/deep/x')
  })

  test('a path no prefix matches is a 404 rather than a blind fetch', async () => {
    // `handle` is normally only reached after `canHandle`, but it is a public
    // static and must fail closed on its own — no `proxyUrl` means no request
    // leaves the process.
    seen = null
    const res = await ProxyHandler.handle(
      UNMATCHED,
      new Request(`http://caller.example${UNMATCHED}`),
    )

    expect(res).toBeInstanceOf(Response)
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('Not Found')
    expect(seen).toBeNull()
  })

  test('an unreachable upstream is a 502, not a thrown 500', async () => {
    const res = await get('/dead/anything')

    expect(res.status).toBe(502)
    expect(await res.text()).toBe('Bad Gateway')
  })

  test('the upstream status and headers pass through', async () => {
    const res = await get('/one/gzipped')

    expect(res.status).toBe(201)
    expect(res.headers.get('x-upstream')).toBe('yes')
  })

  /**
   * Bun's `fetch` decompresses transparently but leaves the upstream's
   * `content-encoding` and `content-length` on the response object. Forwarding
   * them describes the body we are *not* sending: the client tries to gunzip
   * plaintext, or truncates at the compressed length.
   */
  test('content-encoding and content-length are dropped from the response', async () => {
    const res = await get('/one/gzipped')

    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    // And the body really is the decompressed one, so this is not passing
    // because nothing was proxied.
    expect(await res.text()).toBe(GZIP_BODY)
  })

  test('a non-GET body is forwarded', async () => {
    const res = await ProxyHandler.handle(
      '/one/submit',
      new Request('http://caller.example/one/submit', {
        method: 'POST',
        body: 'order=croissant',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    )

    expect(res.status).toBe(200)
    const received = seen as Seen
    expect(received.method).toBe('POST')
    expect(received.body).toBe('order=croissant')
  })
})
