import { afterEach, describe, expect, test } from 'bun:test'
import { history1m } from './core'
import { startAnalyticsLoop, stopAnalyticsLoop } from './loop'

/**
 * A stand-in for the `Bun.Server` the loop pings, whose `fetch` takes longer
 * than the interval it is driven at. That is the whole condition: `setInterval`
 * fires on a wall clock and does not wait for an async body, so a body slower
 * than the interval overlaps with itself.
 */
function slowServer(durationMs: number) {
  let inFlight = 0

  const state = {
    peak: 0,
    calls: 0,
    fetch: async () => {
      inFlight++
      state.calls++
      state.peak = Math.max(state.peak, inFlight)
      await Bun.sleep(durationMs)
      inFlight--
      return new Response('pong', { status: 200 })
    },
  }

  return state
}

afterEach(async () => {
  stopAnalyticsLoop()
  // Let any tick that was mid-flight settle before the next test starts.
  await Bun.sleep(80)
  history1m.length = 0
})

describe('analytics loop scheduling', () => {
  test('ticks never overlap, even when the body outruns the interval', async () => {
    // 60ms of work on a 20ms interval. Under `setInterval` the second tick
    // starts while the first is still in flight and the pings pile up, each
    // one adding load that lengthens the next.
    const server = slowServer(60)

    startAnalyticsLoop(server, 20)
    await Bun.sleep(400)
    stopAnalyticsLoop()

    expect(server.calls).toBeGreaterThan(1)
    expect(server.peak).toBe(1)
  })

  test('a tick is scheduled from the end of the previous one', async () => {
    // The corollary of re-arming in `finally`: the loop degrades to a slower
    // sample rate under load rather than to an unbounded queue of them. With
    // a 60ms body on a 20ms interval, 400ms allows at most ~5 ticks; the
    // overlapping version fires ~20.
    const server = slowServer(60)

    startAnalyticsLoop(server, 20)
    await Bun.sleep(400)
    stopAnalyticsLoop()

    expect(server.calls).toBeLessThanOrEqual(6)
    // One snapshot per completed tick, so the counters that
    // `pushAnalyticsSnapshot` zeroes are never emptied under a tick still
    // running.
    expect(history1m.length).toBeLessThanOrEqual(server.calls)
  })

  test('stopping mid-tick does not let the loop re-arm itself', async () => {
    const server = slowServer(60)

    startAnalyticsLoop(server, 20)
    await Bun.sleep(40)
    stopAnalyticsLoop()

    const afterStop = server.calls
    await Bun.sleep(200)

    expect(server.calls).toBe(afterStop)
  })
})
