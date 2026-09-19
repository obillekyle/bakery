import { beforeEach, describe, expect, test } from 'bun:test'
import * as core from './core'
import { connectedAnalyticsClients } from './endpoints/websocket'
import { broadcastStats } from './loop'

/**
 * The per-second counters zero on every `pushAnalyticsSnapshot`, and the
 * aggregation buckets only ever grow, so every assertion here is written
 * against a *delta* taken in the same test. That keeps the file independent of
 * whatever ran before it without adding a reset seam that only tests would
 * use.
 */
function sample() {
  core.pushAnalyticsSnapshot({
    timestamp: Date.now(),
    memoryUsed: 100,
    activeLoggers: 0,
    activeSessions: 0,
    ping: 1,
  })
  return core.getLatestAnalyticsSnapshot()
}

describe('the loop does not count itself', () => {
  test('the tick ping is not traffic', () => {
    sample() // zero the per-second counters

    // `runAnalyticsTick` fetches this path through the real server once a
    // second to time a round trip, and it reached `onRoute` like any other
    // request. An idle server therefore reported one route hit and one unique
    // request every second, for ever.
    core.recordRouteHit('GET', '/_analytics/ping')
    core.recordRouteHit('GET', '/api/_analytics/stats')
    core.recordRouteHit('GET', '/api/_analytics/reset')

    const latest = sample()
    expect(latest.routeHits).toBe(0)
    expect(latest.uniqueRequests).toBe(0)
  })

  test('a path that merely starts with the same prefix is traffic', () => {
    // Exact matches, not prefixes: `/_analytics/pingback` belongs to the app.
    sample()
    core.recordRouteHit('GET', '/_analytics/pingback')
    expect(sample().routeHits).toBe(1)
  })

  test('isSelfPath names exactly the three the loop generates', () => {
    expect(core.isSelfPath('/_analytics/ping')).toBe(true)
    expect(core.isSelfPath('/api/_analytics/stats')).toBe(true)
    expect(core.isSelfPath('/api/_analytics/reset')).toBe(true)
    expect(core.isSelfPath('/_analytics/pingback')).toBe(false)
    expect(core.isSelfPath('/')).toBe(false)
  })
})

describe('the in-progress aggregation survives a restart', () => {
  test('snapshotTemps round-trips through loadTemps', () => {
    const before = core.snapshotTemps().temp1h.count

    for (let i = 0; i < 12; i++) {
      core.recordRouteHit('GET', `/round-trip/${i}`)
      sample()
    }

    // This is the half that did not exist. `setup.ts` read `data.temp1h` on
    // boot and `loadTemps` knew how to restore it, but nothing ever wrote it,
    // so the check was always false and every restart aggregated from zero.
    const saved = core.snapshotTemps()
    const grew = saved.temp1h.count - before
    expect(grew).toBeGreaterThan(0)

    // Serialised, because a JSON column in the `core` row is what holds it.
    const roundTripped = JSON.parse(JSON.stringify(saved))

    core.loadTemps({ temp1h: { ...roundTripped.temp1h, count: 7, routeHits: 9 } })
    expect(core.snapshotTemps().temp1h.count).toBe(7)
    expect(core.snapshotTemps().temp1h.routeHits).toBe(9)

    // And restore something plausible so a later file is not handed a bucket
    // claiming seven samples that never happened.
    core.loadTemps({ temp1h: roundTripped.temp1h })
    expect(core.snapshotTemps().temp1h.count).toBe(saved.temp1h.count)
  })

  test('the four buckets are all in the snapshot', () => {
    const snap = core.snapshotTemps()
    expect(Object.keys(snap).sort()).toEqual([
      'temp1d',
      'temp1h',
      'temp30d',
      'temp7d',
    ])
  })
})

describe('one computeStats per window, not per client', () => {
  function fakeClient(timescale: string, pagesFilter: string) {
    const sent: string[] = []
    return {
      sent,
      data: { data: { timescale, pagesFilter, excludeHistory: true } },
      send: (frame: string) => void sent.push(frame),
    }
  }

  function counting() {
    const state = { calls: 0 }
    const fn = ((t: string, _e: boolean, f: string) => {
      state.calls++
      return { window: `${t}/${f}` }
    }) as any
    return { state, fn }
  }

  beforeEach(() => {
    connectedAnalyticsClients.clear()
  })

  test('five consoles on the same window cost one call', () => {
    const clients = Array.from({ length: 5 }, () => fakeClient('1m', '1d'))
    for (const c of clients) connectedAnalyticsClients.add(c)

    const { state, fn } = counting()
    broadcastStats(fn)

    expect(state.calls).toBe(1)
    for (const c of clients) expect(c.sent.length).toBe(1)
    expect(new Set(clients.map(c => c.sent[0])).size).toBe(1)
  })

  test('clients on different windows each get their own', () => {
    const a = fakeClient('1m', '1d')
    const b = fakeClient('1h', '1d')
    const c = fakeClient('1m', '7d')
    const d = fakeClient('1m', '1d')
    for (const x of [a, b, c, d]) connectedAnalyticsClients.add(x)

    const { state, fn } = counting()
    broadcastStats(fn)

    // Three distinct windows across four clients.
    expect(state.calls).toBe(3)
    expect(a.sent[0]).toBe(d.sent[0])
    expect(a.sent[0]).not.toBe(b.sent[0])
    expect(a.sent[0]).not.toBe(c.sent[0])
  })

  test('no clients means no work', () => {
    const { state, fn } = counting()
    broadcastStats(fn)
    expect(state.calls).toBe(0)
  })
})
