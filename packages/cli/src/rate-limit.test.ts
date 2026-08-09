import { beforeEach, describe, expect, test } from 'bun:test'
import { SharedMemoryPool } from '@bakery/core/utils/shared-pool'
import {
  __resetRateLimitLogState,
  RATE_LIMIT_LOG_KEYS,
  RATE_LIMIT_LOG_WINDOW_MS,
  RATE_LIMIT_SLOTS,
  rateLimitSlot,
  retryAfterSeconds,
  sampleRateLimitLog,
} from './rate-limit'

/**
 * Guards the *distribution*, not the arithmetic. `Number(Bun.hash(key)) % 1024`
 * is a perfectly ordinary-looking expression that silently collapses the u64
 * hash to 100 reachable buckets with 83% of keys in bucket 0 — an assertion on
 * one hand-picked key would have passed against the bug. What has to fail is a
 * spread that stops being a spread.
 */
function sampleKeys(count: number): string[] {
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    keys.push(
      `${10 + (i % 200)}.${(i >> 3) % 256}.${(i >> 5) % 256}.${i % 256}`,
    )
  }
  return keys
}

describe('rateLimitSlot', () => {
  test('spreads client keys across the whole bucket range', () => {
    const keys = sampleKeys(20_000)
    const seen = new Set<number>()
    const counts = new Map<number, number>()

    for (const key of keys) {
      const slot = rateLimitSlot(key)
      seen.add(slot)
      counts.set(slot, (counts.get(slot) ?? 0) + 1)
    }

    // The broken version reached 100 of 1024 buckets on this exact sample.
    expect(seen.size).toBeGreaterThan(RATE_LIMIT_SLOTS * 0.9)

    // …and put 83% of the sample in one of them. Anything sharing a bucket
    // shares a token budget, so a hot bucket is a shared rate limit.
    const busiest = Math.max(...counts.values())
    expect(busiest / keys.length).toBeLessThan(0.01)
  })

  test('never hashes past the end of the pool region', () => {
    // `consumeToken()` fails closed on an out-of-range slot: a slot the pool
    // rejects is a client that can never make a request at all.
    const pool = new SharedMemoryPool()

    for (const key of sampleKeys(2_000)) {
      const slot = rateLimitSlot(key)
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(RATE_LIMIT_SLOTS)
      expect(Number.isInteger(slot)).toBe(true)
      expect(pool.consumeToken(slot, 100, 10)).toBe(true)
    }
  })

  test('is stable for a given key', () => {
    // Buckets are shared state across cluster workers; an unstable mapping
    // would hand the same client a fresh budget on every request.
    expect(rateLimitSlot('203.0.113.42')).toBe(rateLimitSlot('203.0.113.42'))
    expect(rateLimitSlot('')).toBe(rateLimitSlot(''))
  })
})

/**
 * The limiter absorbs floods; the log must not re-emit them. One RATE_LIMITED
 * line per rejected request is one effectively-synchronous stdout write per
 * rejection, so the flood the limiter blocked came straight back as a logging
 * flood. At most one line per key per window instead.
 */
describe('sampleRateLimitLog', () => {
  beforeEach(() => __resetRateLimitLogState())

  test('the first rejection for a key logs immediately', () => {
    expect(sampleRateLimitLog('203.0.113.7', 1_000)).toBe(0)
  })

  test('repeats inside the window are suppressed', () => {
    sampleRateLimitLog('203.0.113.7', 1_000)
    expect(sampleRateLimitLog('203.0.113.7', 1_001)).toBeNull()
    expect(
      sampleRateLimitLog('203.0.113.7', 999 + RATE_LIMIT_LOG_WINDOW_MS),
    ).toBeNull()
  })

  test('the reopening line reports how many were suppressed', () => {
    const t0 = 1_000
    sampleRateLimitLog('k', t0)
    for (let i = 1; i <= 5; i++) sampleRateLimitLog('k', t0 + i)

    expect(sampleRateLimitLog('k', t0 + RATE_LIMIT_LOG_WINDOW_MS)).toBe(5)
  })

  test('keys are independent', () => {
    sampleRateLimitLog('a', 1_000)
    expect(sampleRateLimitLog('b', 1_000)).toBe(0)
  })

  test('state is bounded: evicted keys log again rather than grow the map', () => {
    // The key derives from client-controlled data (IP / keyBy), so unbounded
    // growth here is convention 6's exact failure mode. Eviction is observable
    // from outside: a key that fell out of the LRU logs as if new, which is
    // over-logging — the safe direction to be wrong in.
    const now = 1_000
    sampleRateLimitLog('first', now)
    expect(sampleRateLimitLog('first', now + 1)).toBeNull()

    for (let i = 0; i < RATE_LIMIT_LOG_KEYS; i++) {
      sampleRateLimitLog(`filler-${i}`, now)
    }

    expect(sampleRateLimitLog('first', now + 2)).toBe(0)
  })
})

describe('retryAfterSeconds', () => {
  test('rounds a sub-second refill up to a whole second', () => {
    // Retry-After is whole seconds (RFC 9110); "0" would mean "retry now".
    expect(retryAfterSeconds(10)).toBe(1)
    expect(retryAfterSeconds(1)).toBe(1)
  })

  test('slow refills wait their full duration', () => {
    expect(retryAfterSeconds(0.5)).toBe(2)
    expect(retryAfterSeconds(0.1)).toBe(10)
  })
})
