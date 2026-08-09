import { describe, expect, test } from 'bun:test'
import {
  type FlushTarget,
  RESPAWN_BASE_DELAY_MS,
  RESPAWN_MAX_DELAY_MS,
  requestWorkerFlush,
  respawnDelayMs,
} from './threads'

/**
 * Guards the bounded pre-terminate flush. `handleShutdown` used to call
 * `worker.terminate()` straight away, which gives a worker no chance to run its
 * shutdown hooks — so buffered session writes waited for the tiered cache's own
 * 30s interval and a cluster shutdown could drop up to a full interval of them.
 *
 * What is covered here is the wait: that every worker is asked, that all
 * acknowledgements resolve it, and that a worker which never answers cannot
 * hang shutdown. What is *not* covered is the real `Worker` round trip — that
 * needs a spawned thread binding a real port, and the message contract is one
 * string on each side. `FlushTarget` exists so the wait can be tested without
 * pretending to test the rest.
 */
class FakeWorker implements FlushTarget {
  readonly received: any[] = []
  private readonly listeners = new Set<(event: any) => void>()

  constructor(private readonly acknowledges: boolean) {}

  postMessage(message: any): void {
    this.received.push(message)
    if (!this.acknowledges) return

    queueMicrotask(() => {
      for (const listener of [...this.listeners]) {
        listener({ data: { type: 'SHUTDOWN_DONE' } })
      }
    })
  }

  addEventListener(_type: 'message', listener: (event: any) => void): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: (event: any) => void): void {
    this.listeners.delete(listener)
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

describe('requestWorkerFlush', () => {
  test('asks every worker to flush and resolves once all acknowledge', async () => {
    const workers = [new FakeWorker(true), new FakeWorker(true)]

    expect(await requestWorkerFlush(workers, 1000)).toBe(true)
    for (const worker of workers) {
      expect(worker.received).toEqual([{ type: 'SHUTDOWN' }])
    }
  })

  test('gives up on a silent worker rather than hanging', async () => {
    const workers = [new FakeWorker(true), new FakeWorker(false)]
    const started = Bun.nanoseconds()

    expect(await requestWorkerFlush(workers, 60)).toBe(false)

    // The point is the bound, not the exact figure: an unbounded wait would
    // never return at all.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(3000)
  })

  test('leaves no listeners behind, acknowledged or not', async () => {
    const acked = new FakeWorker(true)
    await requestWorkerFlush([acked], 1000)
    expect(acked.listenerCount).toBe(0)

    const silent = new FakeWorker(false)
    await requestWorkerFlush([silent], 30)
    expect(silent.listenerCount).toBe(0)
  })

  test('resolves immediately when there are no workers', async () => {
    expect(await requestWorkerFlush([], 30)).toBe(true)
  })

  test('ignores unrelated worker messages', async () => {
    const chatty: FlushTarget & { listenerCount: number } = (() => {
      const listeners = new Set<(event: any) => void>()
      return {
        postMessage() {
          queueMicrotask(() => {
            for (const listener of [...listeners]) {
              listener({ data: { type: 'SOMETHING_ELSE' } })
            }
          })
        },
        addEventListener(_type: 'message', listener: (event: any) => void) {
          listeners.add(listener)
        },
        removeEventListener(_type: 'message', listener: (event: any) => void) {
          listeners.delete(listener)
        },
        get listenerCount() {
          return listeners.size
        },
      }
    })()

    expect(await requestWorkerFlush([chatty], 30)).toBe(false)
    expect(chatty.listenerCount).toBe(0)
  })
})

/**
 * Guards the respawn backoff. The master used to respawn a crashed worker after
 * a fixed 100ms forever, so a worker that died during boot (bad DB URL, port
 * conflict) re-ran initDB/setupServer ~10 times a second indefinitely. The
 * delay is a pure function of the consecutive-failure count; the caller resets
 * that count once a worker survives long enough to be called healthy.
 */
describe('respawnDelayMs', () => {
  test('doubles per consecutive failure from the base delay', () => {
    expect(respawnDelayMs(1)).toBe(RESPAWN_BASE_DELAY_MS)
    expect(respawnDelayMs(2)).toBe(RESPAWN_BASE_DELAY_MS * 2)
    expect(respawnDelayMs(3)).toBe(RESPAWN_BASE_DELAY_MS * 4)
    expect(respawnDelayMs(4)).toBe(RESPAWN_BASE_DELAY_MS * 8)
    expect(respawnDelayMs(8)).toBe(RESPAWN_BASE_DELAY_MS * 128)
  })

  test('caps at the maximum delay', () => {
    // 100 * 2^8 = 25_600 is the last uncapped step; failure 10 would be 51_200
    // uncapped.
    expect(respawnDelayMs(9)).toBe(25_600)
    expect(respawnDelayMs(10)).toBe(RESPAWN_MAX_DELAY_MS)
    expect(respawnDelayMs(11)).toBe(RESPAWN_MAX_DELAY_MS)
  })

  test('stays finite for absurd failure counts', () => {
    // 2 ** 1e9 is Infinity; the exponent must be clamped before the pow, not
    // after it.
    expect(respawnDelayMs(1_000_000_000)).toBe(RESPAWN_MAX_DELAY_MS)
    expect(Number.isFinite(respawnDelayMs(Number.MAX_SAFE_INTEGER))).toBe(true)
  })

  test('treats zero and negative counts as a first failure', () => {
    expect(respawnDelayMs(0)).toBe(RESPAWN_BASE_DELAY_MS)
    expect(respawnDelayMs(-5)).toBe(RESPAWN_BASE_DELAY_MS)
  })
})
