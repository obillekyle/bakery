import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { connectedLoggers } from '@bakery-framework/core/logger'
import {
  setAnalyticsAuthorize,
  setAnalyticsCredential,
} from '@bakery-framework/plugin-analytics/stats'
import { DashboardLogsHandler } from './endpoints/logs-socket'

/**
 * The Logs panel was dead in production, and only in production.
 *
 * Its client connected to `/_livereload`, which `LiveReloadHandler` serves,
 * and that handler is registered only under `DEV` and refuses in `canHandle`
 * besides. A production server answered 400 on the upgrade, nothing ever
 * joined `connectedLoggers`, and the panel sat on "Connecting to server log
 * stream..." for the life of the process. Measured against `bun run serve`
 * before the fix: `/_livereload` → 400 while the console itself → 200.
 *
 * The console has its own socket now, behind the console's own door.
 */
const upgradeHeaders = { upgrade: 'websocket' }
const req = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    headers: { ...upgradeHeaders, ...headers },
  })

beforeEach(() => {
  connectedLoggers.clear()
  setAnalyticsAuthorize(() => true)
  setAnalyticsCredential(undefined)
})

afterAll(() => {
  connectedLoggers.clear()
  setAnalyticsAuthorize(undefined)
  setAnalyticsCredential(undefined)
})

describe('the console log socket', () => {
  test('claims its own path and nothing else', async () => {
    expect(await DashboardLogsHandler.canHandle('/_dashboard/logs', req('/_dashboard/logs'))).toBe(true)

    // Not the live-reload socket, which stays the watcher's.
    expect(await DashboardLogsHandler.canHandle('/_livereload', req('/_livereload'))).toBe(false)
    // Not the console page, which is a fetch route at priority 120.
    expect(await DashboardLogsHandler.canHandle('/_dashboard', req('/_dashboard'))).toBe(false)
    expect(
      await DashboardLogsHandler.canHandle('/_dashboard/logs/extra', req('/_dashboard/logs/extra')),
    ).toBe(false)
  })

  test('a closed door refuses the upgrade', async () => {
    // Every server log line goes over this socket, so it cannot be looser than
    // the page that renders them. With no predicate and no credential the
    // guard denies in production and allows loopback in development; here it
    // is asked directly, so denial is the answer.
    setAnalyticsAuthorize(undefined)
    setAnalyticsCredential(undefined)

    expect(await DashboardLogsHandler.canHandle('/_dashboard/logs', req('/_dashboard/logs'))).toBe(false)
  })

  test('the analytics credential admits it, the same as the console', async () => {
    setAnalyticsAuthorize(undefined)
    setAnalyticsCredential('ops-key-7')

    expect(
      await DashboardLogsHandler.canHandle(
        '/_dashboard/logs',
        req('/_dashboard/logs', { 'x-analytics-key': 'ops-key-7' }),
      ),
    ).toBe(true)

    expect(
      await DashboardLogsHandler.canHandle(
        '/_dashboard/logs',
        req('/_dashboard/logs', { 'x-analytics-key': 'wrong' }),
      ),
    ).toBe(false)
  })

  test('a request-less probe is refused rather than admitted', async () => {
    // The registry can ask without a request. Answering `true` there would be
    // a socket that opens for anyone.
    expect(await DashboardLogsHandler.canHandle('/_dashboard/logs')).toBe(false)
  })

  test('open joins the registry and close leaves it', () => {
    // Membership is all this handler does; core owns the Set and the
    // dashboard's `setLogCallback` does the broadcasting.
    const ws = { id: 'socket-1' } as any
    expect(connectedLoggers.size).toBe(0)

    DashboardLogsHandler.open(ws)
    expect(connectedLoggers.has(ws)).toBe(true)

    DashboardLogsHandler.close(ws)
    expect(connectedLoggers.has(ws)).toBe(false)
    expect(connectedLoggers.size).toBe(0)
  })

  test('it declares the console namespace', async () => {
    expect(DashboardLogsHandler.namespace).toBe('/_dashboard')
  })

  test('the client asks for this socket, not the live-reload one', () => {
    // The actual defect, asserted where it lived. A source grep because the
    // client is browser code that this suite does not execute, and because the
    // failure is silent: the panel renders either way and simply never
    // receives anything.
    const client = readFileSync(
      join(import.meta.dir, 'client', 'parts', 'logs.ts'),
      'utf8',
    )
    expect(client).toContain("getWebSocketUrl('/_dashboard/logs')")
    expect(client).not.toContain("getWebSocketUrl('/_livereload')")
  })
})
