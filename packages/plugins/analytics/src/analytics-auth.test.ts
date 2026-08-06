import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery/core/core/config'
import { DASHPASS_SESSION_KEY } from '@bakery/core/session'
import { AnalyticsWSHandler } from './endpoints/websocket'
import { isAnalyticsAuthorized } from './endpoints/stats'

beforeAll(async () => {
  await initConfig()
})

const originalDashpass = process.env.DASHPASS

afterEach(() => {
  if (originalDashpass === undefined) delete process.env.DASHPASS
  else process.env.DASHPASS = originalDashpass
})

/** A request with a stub session, mirroring what the worker attaches. */
function reqWithSession(values: Record<string, any> = {}) {
  const req = new Request('http://localhost/_analytics_ws')
  Object.defineProperty(req, 'session', {
    value: { get: (k: string, d?: any) => values[k] ?? d },
    configurable: true,
  })
  return req
}

describe('analytics authorization', () => {
  test('fails CLOSED when DASHPASS is unset', () => {
    delete process.env.DASHPASS
    // This previously returned "authorized", so the documented way to disable
    // the dashboard left analytics wide open.
    expect(isAnalyticsAuthorized(reqWithSession())).toBe(false)
  })

  test('rejects an unauthenticated request when DASHPASS is set', () => {
    process.env.DASHPASS = 'secret'
    expect(isAnalyticsAuthorized(reqWithSession())).toBe(false)
  })

  test('accepts a request holding the dashpass marker', () => {
    process.env.DASHPASS = 'secret'
    expect(
      isAnalyticsAuthorized(reqWithSession({ [DASHPASS_SESSION_KEY]: true })),
    ).toBe(true)
  })
})

describe('analytics websocket upgrade', () => {
  test('refuses to upgrade an unauthenticated socket', () => {
    process.env.DASHPASS = 'secret'
    expect(
      AnalyticsWSHandler.canHandle('/_analytics_ws', reqWithSession()),
    ).toBe(false)
  })

  test('refuses to upgrade when DASHPASS is unset', () => {
    delete process.env.DASHPASS
    expect(
      AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        reqWithSession({ [DASHPASS_SESSION_KEY]: true }),
      ),
    ).toBe(false)
  })

  test('upgrades an authenticated socket', () => {
    process.env.DASHPASS = 'secret'
    expect(
      AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        reqWithSession({ [DASHPASS_SESSION_KEY]: true }),
      ),
    ).toBe(true)
  })

  test('ignores unrelated paths', () => {
    process.env.DASHPASS = 'secret'
    expect(
      AnalyticsWSHandler.canHandle(
        '/other',
        reqWithSession({ [DASHPASS_SESSION_KEY]: true }),
      ),
    ).toBe(false)
  })
})
