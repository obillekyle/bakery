import { LRUCache } from '@bakery-framework/core/cache/lru'
import { hostKey } from '@bakery-framework/core/core/bakery'
import { RATE_LIMIT_SLOT_COUNT } from '@bakery-framework/core/utils/shared-pool'

/**
 * Number of token buckets in `SharedMemoryPool`'s rate-limit region, taken
 * from the pool itself. It was a second constant here with a comment asking
 * that the two be kept in step, and `consumeToken()` fails closed on a slot
 * past the end, so a mismatch would deny every client hashed out of range.
 */
export const RATE_LIMIT_SLOTS = RATE_LIMIT_SLOT_COUNT

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
 * second, one busy client 429'd everyone else, and an ordinary page load
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
 * the limiter just absorbed straight to the logger, the 429 path becomes as
 * expensive as the work it was refusing. At most one line per key per
 * `RATE_LIMIT_LOG_WINDOW_MS` instead.
 *
 * Returns `null` when the line must be suppressed, otherwise the number of
 * rejections suppressed since the key's previous line (0 for a first
 * offender). Bounded per convention 6: the key derives from client-controlled
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
 * header. Whole seconds per RFC 9110, and never less than 1: "0" would tell
 * the client to retry immediately, which is the opposite of the point.
 */
export function retryAfterSeconds(refill: number): number {
  return Math.max(1, Math.ceil(1 / refill))
}

/**
 * Bound for the set of URLs proven to be assets, sized like the route cache it
 * sits beside (`HandlerMap.routeCache`): an entry per asset URL an app
 * serves, per configured host. Past it the LRU evicts, and an evicted URL
 * borrows a token on its next request and is proven again.
 */
export const PROVEN_ASSET_KEYS = import.meta.env.THREAD_WORKER ? 500 : 5000

/** Hashes of asset URLs some handler has served successfully. */
const provenAssets = new LRUCache<bigint, true>(PROVEN_ASSET_KEYS)

/**
 * What identifies a request to the proven-asset set: its host, path and query,
 * and what the browser said it was fetching (`Sec-Fetch-Dest`).
 *
 * The destination is part of it because one URL can be two things: a Vue
 * page answers its own URL with HTML for a navigation and with its script for
 * an import. Proving the script must not make the page free. A client can
 * send any `Sec-Fetch-Dest` it likes, but only to its own cost: a different
 * value is a different key, and a key is proven only by a handler serving an
 * asset for it.
 *
 * Hashed, because the query is the client's, and 5000 raw URLs at the length
 * a client may send could hold tens of megabytes. A 64-bit hash collision
 * would make one URL free on another's proof: for any one request, a chance
 * of 5000 in 2^64, about 3 in 10^16.
 *
 * Must be called inside the request's `hostStore` scope, as `hostKey` is.
 */
export function assetKey(path: string, search: string, req: Request): bigint {
  const dest = req.headers.get('sec-fetch-dest') ?? ''
  return Bun.hash.wyhash(`${hostKey(path + search)}
${dest}`)
}

/** Whether a handler has served this key as an asset, and still holds it. */
export function isProvenAsset(key: bigint): boolean {
  return provenAssets.get(key) === true
}

export function proveAsset(key: bigint): void {
  provenAssets.set(key, true)
}

/**
 * Drop a key whose request skipped the bucket and then was not served as an
 * asset: a deleted file, a refused range, a guard that said no. The next
 * request for it borrows a token like any other.
 */
export function forgetAsset(key: bigint): void {
  provenAssets.delete(key)
}

/** Test seam, beside `__resetRateLimitLogState`. */
export function __resetProvenAssets(): void {
  provenAssets.clear()
}
