import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import {
  isAnalyticsAuthorized,
  setAnalyticsAuthorize,
  setAnalyticsCredential,
} from './endpoints/stats'
import { AnalyticsWSHandler } from './endpoints/websocket'

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  // Both are module-level process state; a test that set either must clear it
  // or every file after this one inherits an armed door.
  setAnalyticsCredential(undefined)
  setAnalyticsAuthorize(undefined)
})

const req = (init: RequestInit = {}, path = '/api/_analytics/stats') =>
  new Request(`http://localhost${path}`, init)

describe('analytics authorization', () => {
  test('closed to everyone with nothing configured', async () => {
    expect(
      await isAnalyticsAuthorized(
        req({ headers: { 'x-analytics-key': 'anything' } }),
      ),
    ).toBe(false)
    expect(await isAnalyticsAuthorized(req())).toBe(false)
  })

  test('the credential admits via header, Bearer or query', async () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      await isAnalyticsAuthorized(
        req({ headers: { 'x-analytics-key': 'ops-key-7' } }),
      ),
    ).toBe(true)
    expect(
      await isAnalyticsAuthorized(
        req({ headers: { authorization: 'Bearer ops-key-7' } }),
      ),
    ).toBe(true)
    expect(
      await isAnalyticsAuthorized(
        req({}, '/api/_analytics/stats?analytics-key=ops-key-7'),
      ),
    ).toBe(true)
  })

  test('a wrong or absent credential is refused', async () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      await isAnalyticsAuthorized(
        req({ headers: { 'x-analytics-key': 'wrong' } }),
      ),
    ).toBe(false)
    expect(await isAnalyticsAuthorized(req())).toBe(false)
  })

  test('an authorize predicate is the second door, and fails closed on throw', async () => {
    setAnalyticsAuthorize(r => r.headers.get('x-role') === 'admin')
    expect(
      await isAnalyticsAuthorized(req({ headers: { 'x-role': 'admin' } })),
    ).toBe(true)
    expect(
      await isAnalyticsAuthorized(req({ headers: { 'x-role': 'guest' } })),
    ).toBe(false)

    setAnalyticsAuthorize(() => {
      throw new Error('identity service down')
    })
    expect(await isAnalyticsAuthorized(req())).toBe(false)
  })

  test('either door admits when both are configured', async () => {
    setAnalyticsCredential('ops-key-7')
    setAnalyticsAuthorize(r => r.headers.get('x-role') === 'admin')
    expect(
      await isAnalyticsAuthorized(
        req({ headers: { 'x-analytics-key': 'ops-key-7' } }),
      ),
    ).toBe(true)
    expect(
      await isAnalyticsAuthorized(req({ headers: { 'x-role': 'admin' } })),
    ).toBe(true)
    expect(await isAnalyticsAuthorized(req())).toBe(false)
  })
})

describe('analytics websocket upgrade', () => {
  test('honours the credential', async () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      await AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        req({ headers: { 'x-analytics-key': 'ops-key-7' } }, '/_analytics_ws'),
      ),
    ).toBe(true)
  })

  test('refuses an unauthenticated socket', async () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      await AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        req({}, '/_analytics_ws'),
      ),
    ).toBe(false)
  })

  test('refuses when nothing is configured', async () => {
    expect(
      await AnalyticsWSHandler.canHandle(
        '/_analytics_ws',
        req({ headers: { 'x-analytics-key': 'ops-key-7' } }, '/_analytics_ws'),
      ),
    ).toBe(false)
  })

  test('ignores unrelated paths', async () => {
    setAnalyticsCredential('ops-key-7')
    expect(
      await AnalyticsWSHandler.canHandle(
        '/other',
        req({ headers: { 'x-analytics-key': 'ops-key-7' } }, '/other'),
      ),
    ).toBe(false)
  })
})
