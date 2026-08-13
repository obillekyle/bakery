import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import {
  isErrorResult,
  type RateLimitConfig,
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
    // must still route to the error registry — and `extractErrorData` is what
    // decides what an absent value means, not this predicate.
    expect(isErrorResult({ errorCode: undefined })).toBe(true)
    expect(isErrorResult({ errorCode: 0 })).toBe(true)
    expect(isErrorResult({ errorCode: '' })).toBe(true)
  })

  test('a Response is judged by status even if it has an errorCode property', () => {
    // The two arms are exclusive, not combined. A `Response` subclass or a
    // patched instance carrying `errorCode` is still a successful response if
    // its status says so — otherwise a 200 would be routed into the error
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
    // every primitive, and `Try.return`'s failure sentinel is a **symbol** —
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
    // a 429 means — and with a fast refill `1 / refill` rounds there.
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
    // `$dynamic.test.ts` do — `mock.module` is process-global and never
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

  test('an empty keyBy result falls back to the hostname', () => {
    // Not cosmetic. '' is a perfectly valid key that hashes to one fixed slot,
    // so every request keyBy could not classify would share a single token
    // bucket across every host — one unclassifiable client 429s all of them.
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
