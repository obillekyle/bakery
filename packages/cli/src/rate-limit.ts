import { LRUCache } from '@bakery/core/cache/lru'

/**
 * Number of token buckets in `SharedMemoryPool`'s rate-limit region.
 *
 * Must match `RATE_LIMIT_SLOT_COUNT` there: `consumeToken()` fails closed on an
 * out-of-range slot, so a value that is too large would deny every request that
 * hashed past the end of the region. `rate-limit.test.ts` cross-checks this
 * against a real pool rather than trusting the two constants to stay in step.
 */
export const RATE_LIMIT_SLOTS = 1024

/**
 * Map a rate-limit key (client IP, or whatever `rateLimit.keyBy` returns) onto
 * one of the shared pool's token buckets.
 *
 * `Bun.hash` returns a **u64 bigint**. The original
 * `Number(Bun.hash(key)) % 1024` converted first, so every bit below 2^53 was
 * rounded away before the modulo ever ran: measured over 20k client IPs that
 * left 100 reachable buckets out of 1024 with **83% of all keys in bucket 0**.
 * Rate limiting is on by default at `{max: 100, refill: 10}`, so in practice
 * most clients shared one bucket with a sustained ceiling of 10 requests per
 * second — one busy client 429'd everyone else, and an ordinary page load
 * (many requests inside a single refill tick) tripped it on its own.
 *
 * Taking the modulo in bigint space and converting the small result keeps the
 * low bits, which are the only ones that matter here. `wyhash` is what plain
 * `Bun.hash` already calls; naming it is what makes the return type `bigint`
 * instead of `number | bigint`.
 */
export function rateLimitSlot(key: string): number {
  return Number(Bun.hash.wyhash(key) % BigInt(RATE_LIMIT_SLOTS))
}

/**
 * How long one RATE_LIMITED log line covers for a key. The "30s" in
 * `RATE_LIMITED_SUPPRESSED`'s message text states this value; keep them in
 * step.
 */
export const RATE_LIMIT_LOG_WINDOW_MS = 30_000

/**
 * Bound for the log-sampling state below. A few hundred concurrently-flooding
 * keys is plenty; past it the LRU evicts and the evicted key logs again.
 */
export const RATE_LIMIT_LOG_KEYS = 512

/** Per-key `{last logged, suppressed since}` for `sampleRateLimitLog`. */
const logState = new LRUCache<string, { last: number; suppressed: number }>(
  RATE_LIMIT_LOG_KEYS,
)

/**
 * Whether this rejection's RATE_LIMITED line should be written at all.
 *
 * The constraint is availability under flood: stdout writes are effectively
 * synchronous on Windows, so one log line per rejected request hands the flood
 * the limiter just absorbed straight to the logger — the 429 path becomes as
 * expensive as the work it was refusing. At most one line per key per
 * `RATE_LIMIT_LOG_WINDOW_MS` instead.
 *
 * Returns `null` when the line must be suppressed, otherwise the number of
 * rejections suppressed since the key's previous line (0 for a first
 * offender). Bounded per convention 6 — the key derives from client-controlled
 * data (IP, or `rateLimit.keyBy`), so the state lives in an LRU and an evicted
 * key simply logs again as if new. Over-logging is the safe direction to be
 * wrong in.
 */
export function sampleRateLimitLog(
  key: string,
  now: number = Date.now(),
): number | null {
  const entry = logState.get(key)
  if (entry && now - entry.last < RATE_LIMIT_LOG_WINDOW_MS) {
    entry.suppressed++
    return null
  }

  const suppressed = entry?.suppressed ?? 0
  logState.set(key, { last: now, suppressed: 0 })
  return suppressed
}

/** Test seam, in the family of `__resetTestConfig` / `__resetTestDb`. */
export function __resetRateLimitLogState(): void {
  logState.clear()
}

/**
 * Seconds until the bucket holds a token again, for the 429's `Retry-After`
 * header. Whole seconds per RFC 9110, and never less than 1 — "0" would tell
 * the client to retry immediately, which is the opposite of the point.
 */
export function retryAfterSeconds(refill: number): number {
  return Math.max(1, Math.ceil(1 / refill))
}
