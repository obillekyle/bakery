import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { Handler } from '@bakery-framework/core/handlers'
import {
  answeredAsAsset,
  bucketKey,
  checkRateLimits,
  compileRateLimit,
  isErrorResult,
  type RateLimitConfig,
  rateLimitBucket,
  rateLimitKey,
  tooManyRequests,
} from './pipeline'

/**
 * The pure decisions inside `worker.ts`'s `Bun.serve` callback. See
 * `pipeline.ts` for why they are not tested through the server.
 */

describe('isErrorResult', () => {
  test('a Response is an error from 400 up', () => {
    // The boundary is the whole point: `> 400` instead of `>= 400` would let a
    // bare 400 through as a success, so the app's error page never renders for
    // the one status most likely to be returned by hand.
    expect(isErrorResult(new Response('', { status: 399 }))).toBe(false)
    expect(isErrorResult(new Response('', { status: 400 }))).toBe(true)
    expect(isErrorResult(new Response('', { status: 404 }))).toBe(true)
    expect(isErrorResult(new Response('', { status: 500 }))).toBe(true)
  })

  test('an ordinary Response is not an error', () => {
    expect(isErrorResult(new Response('ok'))).toBe(false)
    expect(isErrorResult(new Response('', { status: 204 }))).toBe(false)
    expect(isErrorResult(Response.redirect('http://localhost/x', 302))).toBe(
      false,
    )
  })

  test('a plain object is an error when it carries errorCode', () => {
    expect(isErrorResult({ errorCode: 'E_THING' })).toBe(true)
    expect(isErrorResult({ status: 500 })).toBe(false)
    expect(isErrorResult({})).toBe(false)
  })

  test('errorCode counts by presence, not by truthiness', () => {
    // `'errorCode' in res`, not `res.errorCode`. A handler that builds its
    // result object with the key always present and fills it in conditionally
    // must still route to the error registry, and `extractErrorData` is what
    // decides what an absent value means, not this predicate.
    expect(isErrorResult({ errorCode: undefined })).toBe(true)
    expect(isErrorResult({ errorCode: 0 })).toBe(true)
    expect(isErrorResult({ errorCode: '' })).toBe(true)
  })

  test('a Response is judged by status even if it has an errorCode property', () => {
    // The two arms are exclusive, not combined. A `Response` subclass or a
    // patched instance carrying `errorCode` is still a successful response if
    // its status says so: otherwise a 200 would be routed into the error
    // registry on the strength of a stray property.
    expect(
      isErrorResult(Object.assign(new Response('ok'), { errorCode: 'E' })),
    ).toBe(false)
    // And the converse: status still wins when it is an error status.
    expect(isErrorResult(new Response('', { status: 503, headers: {} }))).toBe(
      true,
    )
  })

  test('non-objects are not errors and do not throw', () => {
    // This is the load-bearing one. `'errorCode' in res` is a TypeError on
    // every primitive, and `Try.return`'s failure sentinel is a **symbol**,
    // so dropping the `is.object` guard makes the rejection path throw inside
    // the code that exists to handle throws, from the one input it is
    // guaranteed to see.
    expect(isErrorResult(Symbol('TryFailure'))).toBe(false)
    expect(isErrorResult('a string body')).toBe(false)
    expect(isErrorResult(42)).toBe(false)
    expect(isErrorResult(true)).toBe(false)
    expect(isErrorResult(null)).toBe(false)
    expect(isErrorResult(undefined)).toBe(false)
    expect(isErrorResult(() => {})).toBe(false)
  })

  test('an array is not an error', () => {
    // `is.object([])` is deliberately `true` in this framework (see CLAUDE.md),
    // so arrays reach the `in` check rather than being filtered out by it. A
    // JSON array body must still be a successful response.
    expect(isErrorResult([])).toBe(false)
    expect(isErrorResult([{ errorCode: 'E' }])).toBe(false)
  })
})

describe('tooManyRequests', () => {
  test('is a 429 carrying a whole-second Retry-After', () => {
    const res = tooManyRequests(10)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('1')
  })

  test('Retry-After is never 0', () => {
    // "0" tells the client to retry immediately, which is the opposite of what
    // a 429 means, and with a fast refill `1 / refill` rounds there.
    for (const refill of [1, 10, 100, 1000]) {
      const value = tooManyRequests(refill).headers.get('Retry-After')
      expect(Number(value)).toBeGreaterThanOrEqual(1)
    }
  })

  test('a slow refill waits longer than a second', () => {
    // 1 token every 4 seconds.
    expect(tooManyRequests(0.25).headers.get('Retry-After')).toBe('4')
  })

  test('the body is readable and the response is not consumed', async () => {
    const res = tooManyRequests(10)
    expect(res.bodyUsed).toBe(false)
    expect(await res.text()).toBe('Too Many Requests')
  })
})

describe('rateLimitKey', () => {
  let savedServer: typeof Bakery.server

  beforeAll(async () => {
    await initConfig()
    // `getClientIp` falls back to `Bakery.server?.requestIP()`. Saved and put
    // back rather than module-mocked, which is the same thing `ip.test.ts` and
    // `$dynamic.test.ts` do: `mock.module` is process-global and never
    // unwinds (convention 9).
    savedServer = Bakery.server
    Bakery.server = undefined as unknown as typeof Bakery.server
  })

  afterAll(() => {
    Bakery.server = savedServer
    __resetTestConfig()
  })

  const rl = (keyBy?: (req: Request) => string): RateLimitConfig => ({
    max: 100,
    refill: 10,
    ...(keyBy ? { keyBy } : {}),
  })

  const req = (headers: Record<string, string> = {}) =>
    new Request('http://localhost/x', { headers })

  test('a configured keyBy decides the key', () => {
    expect(
      rateLimitKey(
        rl(() => 'tenant-7'),
        req(),
        'example.com',
      ),
    ).toBe('tenant-7')
  })

  test('keyBy receives the request', () => {
    const key = rateLimitKey(
      rl(r => r.headers.get('x-api-key') || ''),
      req({ 'x-api-key': 'abc' }),
      'example.com',
    )
    expect(key).toBe('abc')
  })

  test('a keyBy that returns nothing falls back to the client address', () => {
    // The pattern this exists for: an account id when signed in, and nothing
    // otherwise. An empty result used to go straight to the hostname, so
    // every anonymous visitor to a host shared one bucket.
    __setTestConfig({ trustProxy: true })
    const signedOut = req({ 'x-forwarded-for': '9.9.9.9' })
    expect(
      rateLimitKey(
        rl(() => ''),
        signedOut,
        'h',
      ),
    ).toBe('9.9.9.9')
    expect(rateLimitKey({ keyBy: () => undefined }, signedOut, 'h')).toBe(
      '9.9.9.9',
    )
    expect(rateLimitKey({ keyBy: () => null }, signedOut, 'h')).toBe('9.9.9.9')
    __resetTestConfig()
  })

  test('an empty keyBy result with no address falls back to the hostname', () => {
    // Not cosmetic. '' is a perfectly valid key that hashes to one fixed slot,
    // so every request keyBy could not classify would share a single token
    // bucket across every host: one unclassifiable client 429s all of them.
    expect(
      rateLimitKey(
        rl(() => ''),
        req(),
        'example.com',
      ),
    ).toBe('example.com')
  })

  test('without keyBy the key is the client IP', () => {
    __setTestConfig({ trustProxy: true })
    expect(rateLimitKey(rl(), req({ 'x-forwarded-for': '9.9.9.9' }), 'h')).toBe(
      '9.9.9.9',
    )
    __resetTestConfig()
  })

  test('an undeterminable client IP falls back to the hostname', () => {
    // `Bakery.server` is unset here, so `getClientIp` returns ''. Same hazard
    // as the empty keyBy above, and it is the reachable one: it is the state
    // of every request that arrives before the serve handle is assigned.
    __setTestConfig({ trustProxy: true })
    expect(rateLimitKey(rl(), req(), 'example.com')).toBe('example.com')
    __resetTestConfig()
  })

  test('the fallback is per-host, so two hosts do not share a bucket', () => {
    const a = rateLimitKey(
      rl(() => ''),
      req(),
      'a.example.com',
    )
    const b = rateLimitKey(
      rl(() => ''),
      req(),
      'b.example.com',
    )
    expect(a).not.toBe(b)
  })
})

describe('compileRateLimit', () => {
  test('rules come out most specific first', () => {
    const limit = compileRateLimit({
      max: 100,
      refill: 10,
      routes: [
        { prefix: '/api', max: 50, refill: 5 },
        { prefix: '/api/auth/sign-in', max: 5, refill: 0.1 },
        { prefix: '/api/auth', max: 10, refill: 1 },
      ],
    })
    expect(limit.routes.map(r => r.prefix)).toEqual([
      '/api/auth/sign-in',
      '/api/auth',
      '/api',
    ])
    expect(limit.base.prefix).toBe('')
  })

  test('a prefix is normalized the way routing reads a path', () => {
    const limit = compileRateLimit({
      max: 1,
      refill: 1,
      routes: [{ prefix: '/API//Auth/', max: 1, refill: 1 }],
    })
    expect(limit.routes[0]!.prefix).toBe('/api/auth')
    expect(limit.routes[0]!.segments).toEqual(['api', 'auth'])
  })

  test('the same setting object is checked once', () => {
    const rl: RateLimitConfig = { max: 1, refill: 1 }
    expect(compileRateLimit(rl)).toBe(compileRateLimit(rl))
  })

  test('a setting that cannot mean anything names its field', () => {
    const bad: [RateLimitConfig, RegExp][] = [
      [{ max: 0, refill: 1 }, /rateLimit\.max must be a number of 1 or more/],
      [{ max: 10, refill: 0 }, /rateLimit\.refill must be a number above 0/],
      [{ max: 10, refill: Number.NaN }, /rateLimit\.refill/],
      [{ max: 10, refill: 1, keyBy: 'ip' as any }, /rateLimit\.keyBy/],
      [{ max: 10, refill: 1, routes: {} as any }, /rateLimit\.routes must be/],
      [
        { max: 10, refill: 1, routes: [{ prefix: 'api', max: 1, refill: 1 }] },
        /rateLimit\.routes\[0\]\.prefix must be a path starting with "\/"/,
      ],
      [
        { max: 10, refill: 1, routes: [{ prefix: '/a', max: 1, refill: -1 }] },
        /rateLimit\.routes\[0\]\.refill/,
      ],
      [
        {
          max: 10,
          refill: 1,
          routes: [
            { prefix: '/api/auth', max: 1, refill: 1 },
            { prefix: '/API/auth/', max: 2, refill: 1 },
          ],
        },
        /rateLimit\.routes\[1\]\.prefix covers \/api\/auth, as an earlier rule does/,
      ],
    ]
    for (const [rl, message] of bad) {
      expect(() => compileRateLimit(rl)).toThrow(message)
    }
  })
})

describe('checkRateLimits', () => {
  test('names the host whose setting is broken', () => {
    const config = {
      rateLimit: { max: 10, refill: 1 },
      hosts: {
        'school.example': { rateLimit: { max: 10, refill: 0 } },
        'quiet.example': { rateLimit: false },
      },
    } as unknown as ProcessedAppConfig
    expect(() => checkRateLimits(config)).toThrow(
      /hosts\['school\.example'\]\.rateLimit\.refill/,
    )
  })

  test('a disabled limit has nothing to check', () => {
    const config = {
      rateLimit: false,
      hosts: {},
    } as unknown as ProcessedAppConfig
    expect(() => checkRateLimits(config)).not.toThrow()
  })
})

describe('rateLimitBucket', () => {
  const limit = compileRateLimit({
    max: 100,
    refill: 10,
    routes: [
      { prefix: '/api/auth', max: 10, refill: 1 / 30 },
      { prefix: '/api/auth/sign-in', max: 5, refill: 1 / 60 },
    ],
  })
  const prefixOf = (path: string) => rateLimitBucket(limit, path).prefix

  test('the longest covering prefix wins', () => {
    expect(prefixOf('/api/auth/sign-in')).toBe('/api/auth/sign-in')
    expect(prefixOf('/api/auth/reset')).toBe('/api/auth')
    expect(prefixOf('/api/auth')).toBe('/api/auth')
  })

  test('a path no rule covers goes to the top level', () => {
    expect(prefixOf('/')).toBe('')
    expect(prefixOf('/api/notes')).toBe('')
    expect(prefixOf('/dashboard')).toBe('')
  })

  test('segments are whole: /api/auth does not cover /api/authors', () => {
    expect(prefixOf('/api/authors')).toBe('')
    expect(prefixOf('/api/auth-old')).toBe('')
  })

  test('spellings routing reads as the same path get the same rule', () => {
    // `$routing.ts` drops empty segments, so `/api//auth/sign-in` reaches
    // `api/auth/sign-in.ts`. Matched on the raw string, that spelling would
    // spend from the top level's 100 instead of the rule's 5.
    expect(prefixOf('/api//auth/sign-in')).toBe('/api/auth/sign-in')
    expect(prefixOf('//api/auth/sign-in/')).toBe('/api/auth/sign-in')
    expect(prefixOf('/API/Auth/Sign-In')).toBe('/api/auth/sign-in')
  })

  test('with no rules every path is the top level', () => {
    const plain = compileRateLimit({ max: 1, refill: 1 })
    expect(rateLimitBucket(plain, '/api/auth')).toBe(plain.base)
  })

  test('a rule for / covers everything', () => {
    const all = compileRateLimit({
      max: 1,
      refill: 1,
      routes: [{ prefix: '/', max: 7, refill: 1 }],
    })
    expect(rateLimitBucket(all, '/anything/at/all').max).toBe(7)
    expect(rateLimitBucket(all, '/').max).toBe(7)
  })
})

describe('bucketKey', () => {
  test('a rule keeps its callers apart from the top level and other rules', () => {
    const limit = compileRateLimit({
      max: 1,
      refill: 1,
      routes: [
        { prefix: '/a', max: 1, refill: 1 },
        { prefix: '/b', max: 1, refill: 1 },
      ],
    })
    const keys = [
      bucketKey(limit.base, '203.0.113.9'),
      bucketKey(rateLimitBucket(limit, '/a'), '203.0.113.9'),
      bucketKey(rateLimitBucket(limit, '/b'), '203.0.113.9'),
    ]
    expect(new Set(keys).size).toBe(3)
    // The top level hashes the bare key, as it always has.
    expect(keys[0]).toBe('203.0.113.9')
  })
})

describe('answeredAsAsset', () => {
  class Asset extends Handler {
    static isAsset() {
      return true
    }
  }
  class Page extends Handler {}
  const req = new Request('http://localhost/app.css')

  test('an asset handler answering under 400 served an asset', () => {
    expect(answeredAsAsset(Asset, '/app.css', req, 200)).toBe(true)
    expect(answeredAsAsset(Asset, '/app.css', req, 304)).toBe(true)
    expect(answeredAsAsset(Asset, '/app.css', req, 206)).toBe(true)
  })

  test('an error from an asset handler is not an asset', () => {
    // What keeps a flood of made-up paths counted: StaticHandler is the
    // fallback for every path, and a path that is not there answers 404.
    expect(answeredAsAsset(Asset, '/nope.css', req, 404)).toBe(false)
    expect(answeredAsAsset(Asset, '/app.css', req, 416)).toBe(false)
    expect(answeredAsAsset(Asset, '/app.css', req, 500)).toBe(false)
  })

  test('nothing is an asset unless its handler says so', () => {
    expect(answeredAsAsset(Page, '/', req, 200)).toBe(false)
    expect(answeredAsAsset(undefined, '/', req, 200)).toBe(false)
  })

  test('no response at all is not an asset', () => {
    expect(answeredAsAsset(Asset, '/ws', req, 0)).toBe(false)
  })
})
