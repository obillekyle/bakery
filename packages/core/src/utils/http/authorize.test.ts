import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
// Side effect, and it must come before `withEnvFlag` swaps a descriptor below:
// init is what installs the mode accessors on `process.env`, so capturing one
// before it runs captures nothing and the restore then deletes the accessor
// init installs later. Every server entry imports it first for the same reason
// — `defaultAuthorize` reads `import.meta.env.PROD`, which does not exist until
// this module has run.
import '../../core/init'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { withEnvFlag } from '../../tests/fixtures'
import {
  type AuthorizeFn,
  defaultAuthorize,
  isAuthorized,
  isLoopback,
  resolveAuthorize,
} from './authorize'

const req = (url = 'http://localhost/_admin', headers?: HeadersInit) =>
  new Request(url, { headers })

/**
 * `trustProxy` is the one supported way to reach `getClientIp`'s header path
 * without a live server, and it is what a reverse-proxied deployment actually
 * runs. Every test that sets it clears it on the hook below — the config seam
 * is process state, and a leaked override is the `ip.test.ts` failure mode.
 */
const behindProxy = () => __setTestConfig({ trustProxy: true })

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetTestConfig()
})

describe('isAuthorized', () => {
  test('a supplied predicate decides access', async () => {
    expect(
      await isAuthorized(
        resolveAuthorize(() => true),
        req(),
      ),
    ).toBe(true)
    expect(
      await isAuthorized(
        resolveAuthorize(() => false),
        req(),
      ),
    ).toBe(false)
  })

  test('an async predicate is awaited', async () => {
    expect(
      await isAuthorized(
        resolveAuthorize(async () => true),
        req(),
      ),
    ).toBe(true)
    expect(
      await isAuthorized(
        resolveAuthorize(async () => false),
        req(),
      ),
    ).toBe(false)
  })

  test('a truthy non-boolean is DENIED, not coerced', async () => {
    // The regression test for the divergence this module exists to settle. The
    // dashboard's copy read `Boolean(await authorize(req))`, which admits every
    // truthy value — so a predicate answering with a status string *granted* on
    // "no", and one answering with a count granted on any non-zero. The
    // predicate is application code and its declared return type is only
    // advice; an untyped or transpiled one can hand back anything at all.
    //
    // Every value below is truthy. Every one must be refused.
    const truthy: unknown[] = ['yes', 'no', 1, -1, {}, [], 'false', () => true]

    for (const value of truthy) {
      expect(Boolean(value)).toBe(true) // the value really is truthy
      const authorize = (() => value) as unknown as AuthorizeFn
      expect(await isAuthorized(authorize, req())).toBe(false)
    }

    // ...and a promise resolving to one is refused the same way.
    const asyncTruthy = (async () => 'yes') as unknown as AuthorizeFn
    expect(await isAuthorized(asyncTruthy, req())).toBe(false)
  })

  test('a falsy non-boolean is denied too', async () => {
    for (const value of [undefined, null, 0, '', Number.NaN]) {
      const authorize = (() => value) as unknown as AuthorizeFn
      expect(await isAuthorized(authorize, req())).toBe(false)
    }
  })

  test('a throwing predicate denies rather than granting', async () => {
    // An authorization check that errors is indeterminate, and indeterminate
    // must fail closed — convention 2.
    const sync = resolveAuthorize(() => {
      throw new Error('identity service down')
    })
    expect(await isAuthorized(sync, req())).toBe(false)

    const asyncFn = resolveAuthorize(async () => {
      throw new Error('session store unreachable')
    })
    expect(await isAuthorized(asyncFn, req())).toBe(false)
  })

  test('a rejected promise denies, and does not escape as an unhandled throw', async () => {
    const authorize = (() =>
      Promise.reject(new Error('nope'))) as unknown as AuthorizeFn
    expect(await isAuthorized(authorize, req())).toBe(false)
  })
})

describe('resolveAuthorize', () => {
  test('falls back to the default when no predicate is given', () => {
    expect(resolveAuthorize()).toBe(defaultAuthorize)
    expect(resolveAuthorize(undefined)).toBe(defaultAuthorize)
  })

  test('returns the supplied predicate unwrapped', () => {
    const fn: AuthorizeFn = () => true
    expect(resolveAuthorize(fn)).toBe(fn)
  })
})

describe('isLoopback', () => {
  test('the request host is not evidence of loopback', () => {
    // `req.url` is built from the client's own `Host` header, and DEFAULT_HOST
    // is 0.0.0.0, so a dev server listens on every interface. No server and no
    // trusted proxy header here, so `getClientIp` yields nothing:
    // indeterminate, therefore denied, whatever the URL says.
    expect(isLoopback(req('http://localhost/_admin'))).toBe(false)
    expect(isLoopback(req('http://127.0.0.1/_admin'))).toBe(false)
    expect(isLoopback(req('http://example.com/_admin'))).toBe(false)
  })

  test('loopback is recognised from the peer address', () => {
    behindProxy()

    expect(
      isLoopback(
        req('http://example.com/_admin', { 'x-real-ip': '127.0.0.1' }),
      ),
    ).toBe(true)
    expect(
      isLoopback(req('http://example.com/_admin', { 'x-real-ip': '::1' })),
    ).toBe(true)
    expect(
      isLoopback(
        req('http://example.com/_admin', { 'x-real-ip': '::ffff:127.0.0.1' }),
      ),
    ).toBe(true)
  })

  test('the string "localhost" is not a loopback address', () => {
    behindProxy()

    // A peer address is never the hostname `localhost`. Accepting it would mean
    // `X-Forwarded-For: localhost` counted as loopback under trustProxy — a
    // header the requester writes.
    expect(
      isLoopback(req('http://localhost/_admin', { 'x-real-ip': 'localhost' })),
    ).toBe(false)
    expect(
      isLoopback(
        req('http://localhost/_admin', { 'x-forwarded-for': 'localhost' }),
      ),
    ).toBe(false)
  })

  test('a LAN peer claiming Host: localhost is denied', () => {
    behindProxy()

    // The live reproduction: a peer address that is not loopback, and a Host
    // header that says otherwise.
    expect(
      isLoopback(req('http://localhost/_admin', { 'x-real-ip': '10.0.0.6' })),
    ).toBe(false)
  })

  test('denies when getClientIp throws', () => {
    behindProxy()

    // getClientIp reads config and the live server, either of which may be
    // absent (tests, early boot). This stands in for that: a request whose
    // headers cannot be read at all. The guard must answer `false`, not
    // propagate — an indeterminate address is a denial.
    const hostile = {
      url: 'http://localhost/_admin',
      headers: {
        get() {
          throw new Error('headers unavailable')
        },
      },
    } as unknown as Request

    expect(() => isLoopback(hostile)).not.toThrow()
    expect(isLoopback(hostile)).toBe(false)
  })
})

describe('defaultAuthorize', () => {
  test('denies in production even from loopback', async () => {
    behindProxy()
    const local = req('http://localhost/_admin', { 'x-real-ip': '127.0.0.1' })

    // The precondition: this exact request *is* loopback, so the denial below
    // is the PROD gate and not a failed address check.
    expect(isLoopback(local)).toBe(true)

    await withEnvFlag('DEV', false, () => {
      expect(defaultAuthorize(local)).toBe(false)
      expect(
        defaultAuthorize(
          req('http://example.com/_admin', { 'x-real-ip': '::1' }),
        ),
      ).toBe(false)
      expect(defaultAuthorize(req('http://example.com/_admin'))).toBe(false)
    })
  })

  test('outside production it is loopback-only', async () => {
    behindProxy()

    await withEnvFlag('DEV', true, () => {
      expect(
        defaultAuthorize(
          req('http://example.com/_admin', { 'x-real-ip': '127.0.0.1' }),
        ),
      ).toBe(true)
      expect(
        defaultAuthorize(
          req('http://example.com/_admin', { 'x-real-ip': '10.0.0.6' }),
        ),
      ).toBe(false)
      // No address at all is indeterminate, so denied.
      expect(defaultAuthorize(req('http://localhost/_admin'))).toBe(false)
    })
  })

  test('the flag is read at call time, not at module load', async () => {
    behindProxy()
    const local = req('http://localhost/_admin', { 'x-real-ip': '127.0.0.1' })

    // Same function, same request, opposite answers — which is only possible if
    // `import.meta.env.DEV` is consulted inside the call. A copy that captured
    // the flag in a module-level const would return one value both times.
    const inProd = await withEnvFlag('DEV', false, () =>
      defaultAuthorize(local),
    )
    const outside = await withEnvFlag('DEV', true, () =>
      defaultAuthorize(local),
    )

    expect(inProd).toBe(false)
    expect(outside).toBe(true)
  })

  test('an unset DEV denies, rather than falling through to loopback', async () => {
    // The gate tests for the positive development marker (`DEV === '1'`), not
    // `if (!PROD)`, and this is why. The mode flags do not exist until
    // `core/init.ts` has run; a spelling that reads `undefined` as "not
    // production" opens the loopback door in a process that has established
    // nothing at all.
    //
    // It read `PROD !== false` while the flags were booleans. They are
    // `'1'`/`''` strings since Bun 1.4 stopped allowing accessors on
    // `process.env`, and `!== false` would be true for every one of them —
    // including the `''` a development server sets, which would have denied on
    // loopback in development while still looking like a correct gate.
    //
    // `behindProxy` matters here: it gives `getClientIp` a header to read, so
    // `isLoopback` *would* answer true and the request really would be admitted
    // by the weaker spelling. Without it this test would pass against the bug.
    behindProxy()
    const local = req('http://localhost/_admin', { 'x-real-ip': '127.0.0.1' })
    expect(isLoopback(local)).toBe(true)

    await withEnvFlag('DEV', undefined, () => {
      expect(defaultAuthorize(local)).toBe(false)
    })
  })

  test('an unconfigured plugin is closed under the ambient test flags', async () => {
    // `bun test` runs with DEV false and PROD true, so the shipped default with
    // nothing configured admits nobody — which is the whole safety claim.
    behindProxy()
    expect(import.meta.env.PROD).toBeTruthy()
    expect(
      await isAuthorized(
        resolveAuthorize(),
        req('http://localhost/_admin', { 'x-real-ip': '127.0.0.1' }),
      ),
    ).toBe(false)
  })
})
