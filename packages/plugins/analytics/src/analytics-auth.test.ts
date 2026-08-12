import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { DASHPASS_SESSION_KEY } from '@bakery-framework/core/session'
import {
  isAnalyticsAuthorized,
  setAnalyticsCredential,
} from './endpoints/stats'
import { AnalyticsWSHandler } from './endpoints/websocket'

beforeAll(async () => {
  await initConfig()
})

const originalDashpass = process.env.DASHPASS

afterEach(() => {
  if (originalDashpass === undefined) delete process.env.DASHPASS
  else process.env.DASHPASS = originalDashpass
  // The credential is module-level process state; a test that set it must put
  // it back or every file loaded after this one inherits an armed door.
  setAnalyticsCredential(undefined)
})

/** A request with a stub session, mirroring what the worker attaches. */
function reqWithSession(
  values: Record<string, any> = {},
  init: RequestInit = {},
) {
  const req = new Request('http://localhost/_analytics_ws', init)
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

describe('analytics credential door', () => {
  test('an unset credential is off, not open', () => {
    delete process.env.DASHPASS
    setAnalyticsCredential(undefined)
    expect(
      isAnalyticsAuthorized(
        reqWithSession({}, { headers: { 'x-analytics-key': 'anything' } }),
      ),
    ).toBe(false)
  })

  test('admits on the credential with no session and no DASHPASS', () => {
    delete process.env.DASHPASS
    setAnalyticsCredential('ops-key-7')

    // The reachable path today: no session flag is ever set, so this is how
    // the dashboard or a script actually gets in.
    expect(
      isAnalyticsAuthorized(
        reqWithSession({}, { headers: { 'x-analytics-key': 'ops-key-7' } }),
      ),
    ).toBe(true)
    expect(
      isAnalyticsAuthorized(
        reqWithSession({}, { headers: { authorization: 'Bearer ops-key-7' } }),
      ),
    ).toBe(true)
    expect(isAnalyticsAuthorized(reqWithSession())).toBe(false)
    expect(
      isAnalyticsAuthorized(
        reqWithSession({}, { headers: { 'x-analytics-key': 'wrong' } }),
      ),
    ).toBe(false)
  })

  test('the query spelling admits too', () => {
    setAnalyticsCredential('ops-key-7')
    const req = new Request(
      'http://localhost/api/_analytics/stats?analytics-key=ops-key-7',
    )
    expect(isAnalyticsAuthorized(req)).toBe(true)
  })

  test('the websocket honours the credential', () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        reqWithSession({}, { headers: { 'x-analytics-key': 'ops-key-7' } }),
      ),
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
