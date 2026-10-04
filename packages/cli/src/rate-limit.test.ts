import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { Bakery, hostStore } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { SharedMemoryPool } from '@bakery-framework/core/utils/shared-pool'
import {
  __resetProvenAssets,
  __resetRateLimitLogState,
  assetKey,
  forgetAsset,
  isProvenAsset,
  PROVEN_ASSET_KEYS,
  proveAsset,
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
 * hash to 100 reachable buckets with 83% of keys in bucket 0: an assertion on
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
    // 200,000 distinct keys (the generator repeats only past 204,800), enough
    // to reach nearly every one of 16384 slots by chance alone.
    const keys = sampleKeys(200_000)
    const seen = new Set<number>()
    const counts = new Map<number, number>()

    for (const key of keys) {
      const slot = rateLimitSlot(key)
      seen.add(slot)
      counts.set(slot, (counts.get(slot) ?? 0) + 1)
    }

    // The broken version reached 100 of 1024 buckets on a 20,000-key sample.
    // At 16384 slots and this sample it reaches 1320 (measured).
    expect(seen.size).toBeGreaterThan(RATE_LIMIT_SLOTS * 0.9)

    // …and put 83% of that sample in one of them, 8.4% of this one. Anything
    // sharing a bucket shares a token budget, so a hot bucket is a shared
    // rate limit.
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
    // over-logging, the safe direction to be wrong in.
    const now = 1_000
    sampleRateLimitLog('first', now)
    expect(sampleRateLimitLog('first', now + 1)).toBeNull()

    for (let i = 0; i < RATE_LIMIT_LOG_KEYS; i++) {
      sampleRateLimitLog(`filler-${i}`, now)
    }

    expect(sampleRateLimitLog('first', now + 2)).toBe(0)
  })
})

/**
 * The URLs a handler has served as assets, which then skip the bucket. What
 * matters is what a key does and does not cover: a key too coarse makes a
 * page free on its script's proof, one keyed on something unbounded grows
 * without limit.
 */
describe('proven assets', () => {
  beforeEach(() => __resetProvenAssets())
  afterAll(() => __resetTestConfig())

  const req = (url: string, dest?: string) =>
    new Request(`http://localhost${url}`, {
      headers: dest ? { 'sec-fetch-dest': dest } : {},
    })
  const key = (path: string, search = '', dest?: string) =>
    assetKey(path, search, req(path + search, dest))

  test('a URL is proven once served, and forgotten on demand', () => {
    const k = key('/app.css')
    expect(isProvenAsset(k)).toBe(false)
    proveAsset(k)
    expect(isProvenAsset(k)).toBe(true)
    forgetAsset(k)
    expect(isProvenAsset(k)).toBe(false)
  })

  test('what the browser is fetching is part of the key', () => {
    // A Vue page answers its own URL with HTML for a navigation and with its
    // root script for an import. Proving the script must not make the page
    // free.
    proveAsset(key('/admin/home', '', 'script'))
    expect(isProvenAsset(key('/admin/home', '', 'script'))).toBe(true)
    expect(isProvenAsset(key('/admin/home', '', 'document'))).toBe(false)
    expect(isProvenAsset(key('/admin/home'))).toBe(false)
  })

  test('the query is part of the key', () => {
    proveAsset(key('/admin/home', '?__vue_css'))
    expect(isProvenAsset(key('/admin/home', '?__vue_css'))).toBe(true)
    expect(isProvenAsset(key('/admin/home'))).toBe(false)
    expect(isProvenAsset(key('/admin/home', '?__vue_action=save'))).toBe(false)
  })

  test('two configured hosts are kept apart', async () => {
    await initConfig()
    __setTestConfig({ hosts: { 'a.example': {}, 'b.example': {} } })
    const under = (hostname: string) =>
      hostStore.run({ config: Bakery.config, hostname }, () => key('/app.css'))

    proveAsset(under('a.example'))
    expect(isProvenAsset(under('a.example'))).toBe(true)
    expect(isProvenAsset(under('b.example'))).toBe(false)
    __resetTestConfig()
  })

  test('the set is bounded: past the limit the oldest URL is dropped', () => {
    // The keys derive from the client's URL, so this is convention 6. An
    // evicted URL is not lost, only unproven: its next request borrows a
    // token and proves it again.
    const first = key('/first.js')
    proveAsset(first)
    for (let i = 0; i < PROVEN_ASSET_KEYS; i++) proveAsset(key(`/f${i}.js`))
    expect(isProvenAsset(first)).toBe(false)
    expect(isProvenAsset(key(`/f${PROVEN_ASSET_KEYS - 1}.js`))).toBe(true)
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
