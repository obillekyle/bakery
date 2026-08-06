import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery/core/core/config'
import {
  defaultAuthorize,
  isAuthorized,
  isLoopback,
  resolveAuthorize,
} from './authorize'

const req = (url = 'http://localhost/_dashboard', headers?: HeadersInit) =>
  new Request(url, { headers })

beforeAll(async () => {
  await initConfig()
})

afterAll(() => {
  __resetTestConfig()
})

describe('dashboard authorization', () => {
  test('a supplied predicate decides access', async () => {
    const allow = resolveAuthorize(() => true)
    const deny = resolveAuthorize(() => false)

    expect(await isAuthorized(allow, req())).toBe(true)
    expect(await isAuthorized(deny, req())).toBe(false)
  })

  test('an async predicate is awaited', async () => {
    const authorize = resolveAuthorize(async () => true)
    expect(await isAuthorized(authorize, req())).toBe(true)
  })

  test('a throwing predicate denies rather than granting', async () => {
    // An authorization check that errors is indeterminate, and indeterminate
    // must fail closed — this is the guard convention the framework follows.
    const authorize = resolveAuthorize(() => {
      throw new Error('session store unreachable')
    })
    expect(await isAuthorized(authorize, req())).toBe(false)
  })

  test('a non-boolean return is coerced, not trusted', async () => {
    const authorize = resolveAuthorize((() => undefined) as any)
    expect(await isAuthorized(authorize, req())).toBe(false)
  })

  test('falls back to the default when no predicate is given', () => {
    expect(resolveAuthorize(undefined)).toBe(defaultAuthorize)
  })

  test('the request host is not evidence of loopback', () => {
    // `req.url` is built from the client's own `Host` header, and DEFAULT_HOST
    // is 0.0.0.0, so a dev server listens on every interface. This used to
    // return true — `curl -H "Host: localhost" http://<lan-ip>:PORT/_dashboard`
    // was a 200 from anywhere on the network.
    //
    // No server and no trusted proxy header here, so `getClientIp` yields
    // nothing: indeterminate, therefore denied, whatever the URL says.
    expect(isLoopback(req('http://localhost/_dashboard'))).toBe(false)
    expect(isLoopback(req('http://127.0.0.1/_dashboard'))).toBe(false)
    expect(isLoopback(req('http://example.com/_dashboard'))).toBe(false)
  })

  test('loopback is recognised from the peer address', () => {
    // `trustProxy` is the one supported way to reach `getClientIp`'s header
    // path without a live server, and it is what a reverse-proxied deployment
    // actually runs.
    __setTestConfig({ trustProxy: true })

    expect(
      isLoopback(req('http://example.com/_dashboard', { 'x-real-ip': '127.0.0.1' })),
    ).toBe(true)
    expect(
      isLoopback(req('http://localhost/_dashboard', { 'x-real-ip': '::1' })),
    ).toBe(true)

    __resetTestConfig()
  })

  test('a LAN peer claiming Host: localhost is denied', () => {
    __setTestConfig({ trustProxy: true })

    // The exact live reproduction: a peer address that is not loopback, and a
    // Host header that says otherwise.
    expect(
      isLoopback(req('http://localhost/_dashboard', { 'x-real-ip': '10.0.0.6' })),
    ).toBe(false)

    __resetTestConfig()
  })

  test('the default gate allows loopback only in development', () => {
    // import.meta.env.DEV is false under `bun test`, so this asserts the
    // production half: with nothing configured, nobody gets in.
    expect(import.meta.env.DEV).toBeFalsy()
    expect(defaultAuthorize(req('http://localhost/_dashboard'))).toBe(false)
    expect(defaultAuthorize(req('http://example.com/_dashboard'))).toBe(false)
  })
})
