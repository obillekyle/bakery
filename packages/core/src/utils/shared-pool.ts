const HEADER_INT_COUNT = 16
const COUNTERS_INT_COUNT = 256

/**
 * Number of token buckets, one 64-bit word each (see `consumeToken`).
 *
 * Every rate-limit key hashes into one of these, and keys that land in the
 * same slot share a budget. With N keys live, about N / slots of them share
 * with someone. At 1024, which this was, a school's thousand signed-in
 * accounts would put most of them in a shared bucket; at 16384 about 6% share
 * one, for 128 KB. The cost of the other direction is memory every server
 * process allocates at import, so it grows with a consumer, not ahead of one.
 */
export const RATE_LIMIT_SLOT_COUNT = 16384
const HEADER_BYTES = HEADER_INT_COUNT * 4
const COUNTERS_BYTES = COUNTERS_INT_COUNT * 4
// Eight-byte words, so the region has to start on an eight-byte boundary: it
// does, at 1088, and a BigInt64Array view throws a RangeError if a resized
// header or counter region ever moves it off one.
const RATE_LIMIT_BYTES = RATE_LIMIT_SLOT_COUNT * 8
const BUFFER_START_OFFSET = HEADER_BYTES + COUNTERS_BYTES + RATE_LIMIT_BYTES

/**
 * How far ahead of now a bucket may run, in microseconds: 2^52, about 142
 * years. The bucket arithmetic is done in ordinary numbers, which hold
 * integers exactly up to 2^53, and microseconds since 1970 are about 2^50.7,
 * so a time this far ahead still fits exactly until the year 2112. A burst
 * times an interval longer than this (a million tokens at one a week) is cut
 * to it, which only shrinks the bucket.
 *
 * Numbers, not BigInt, because every request pays for this call. Measured
 * over 2M calls, two adjacent runs: 234 to 243 ns with BigInt only at the
 * load and the store, 547 to 606 ns with BigInt arithmetic throughout, and
 * 104 to 142 ns for the 32-bit pair this replaced.
 */
const MAX_AHEAD_US = 2 ** 52

/**
 * Whole microseconds per token. Whole, so every sum below is an exact
 * integer and the burst boundary never depends on rounding; the cost is a
 * refill rate off by under 0.05% below 1000 a second, and by more only at
 * rates no per-client limit uses.
 */
function tokenInterval(refillRatePerSec: number): number {
  return Math.min(Math.max(Math.round(1e6 / refillRatePerSec), 1), MAX_AHEAD_US)
}

export const COUNTER_SLOTS = {
  TOTAL_REQUESTS: 0,
  TOTAL_ERRORS: 1,
  ACTIVE_CONNECTIONS: 2,
  LATENCY_SUM_MS: 3,
} as const

export class SharedMemoryPool {
  // Definite-assignment assertions because the adopt-an-existing-buffer path
  // assigns all five through `bind()`, and TypeScript's initialization
  // analysis does not follow a method call out of the constructor. Both
  // constructor paths do assign every one of them before returning.
  buffer!: SharedArrayBuffer
  header!: Int32Array
  counters!: Int32Array
  rateLimits!: BigInt64Array

  /**
   * **The default is the layout's own size, not a megabyte.**
   *
   * It was `1024 * 1024`, and the layout uses 9,280 bytes of it: a 64-byte
   * header, 1 KB of counters and 8 KB of rate-limit slots. The remaining
   * 1,039,296 bytes were a `dataPool` region that **nothing read** - grep it
   * across every package and app, and the only reference outside this file was
   * a test asserting it was a `Uint8Array`. So 99.1% of a `SharedArrayBuffer`
   * allocated at import in every server process existed for one assertion.
   *
   * The region is gone rather than shrunk. A scratch area with no consumer is
   * not a feature waiting to be used; it is a number nobody can size, because
   * there is nothing to size it against. Something that needs shared scratch
   * later adds it along with the code that reads it.
   *
   * A larger size is still accepted and still honored, because `bind()` reads
   * the size out of the header rather than trusting `byteLength` - so a
   * cluster master that allocates more and shares it still works.
   */
  constructor(sizeOrBuffer: number | SharedArrayBuffer = BUFFER_START_OFFSET) {
    if (typeof sizeOrBuffer === 'number') {
      const size = Math.max(sizeOrBuffer, BUFFER_START_OFFSET)
      this.buffer = new SharedArrayBuffer(size)
      this.header = new Int32Array(this.buffer, 0, HEADER_INT_COUNT)
      this.counters = new Int32Array(
        this.buffer,
        HEADER_BYTES,
        COUNTERS_INT_COUNT,
      )
      this.rateLimits = new BigInt64Array(
        this.buffer,
        HEADER_BYTES + COUNTERS_BYTES,
        RATE_LIMIT_SLOT_COUNT,
      )
      Atomics.store(this.header, 0, 0x42414b45)
      Atomics.store(this.header, 1, size)
      Atomics.store(this.header, 2, BUFFER_START_OFFSET)
    } else {
      // Adopting a buffer someone else laid out is exactly what `bind` does:
      // it read the header for the size rather than trusting `byteLength`, and
      // so did the copy that used to sit here, character for character.
      this.bind(sizeOrBuffer)
    }
  }

  /** Point every view at `buffer`, taking its size from the header it carries. */
  bind(buffer: SharedArrayBuffer): void {
    this.buffer = buffer
    this.header = new Int32Array(this.buffer, 0, HEADER_INT_COUNT)
    this.counters = new Int32Array(
      this.buffer,
      HEADER_BYTES,
      COUNTERS_INT_COUNT,
    )
    this.rateLimits = new BigInt64Array(
      this.buffer,
      HEADER_BYTES + COUNTERS_BYTES,
      RATE_LIMIT_SLOT_COUNT,
    )
  }

  incrementCounter(slot: number, delta = 1): number {
    if (slot < 0 || slot >= COUNTERS_INT_COUNT) return 0
    return Atomics.add(this.counters, slot, delta) + delta
  }

  decrementCounter(slot: number, delta = 1): number {
    if (slot < 0 || slot >= COUNTERS_INT_COUNT) return 0
    return Atomics.sub(this.counters, slot, delta) - delta
  }

  getCounter(slot: number): number {
    if (slot < 0 || slot >= COUNTERS_INT_COUNT) return 0
    return Atomics.load(this.counters, slot)
  }

  setCounter(slot: number, value: number): number {
    if (slot < 0 || slot >= COUNTERS_INT_COUNT) return 0
    return Atomics.store(this.counters, slot, value)
  }

  /**
   * Take `tokensRequested` from the bucket in `slot`, or answer `false` and
   * take nothing. A bucket holds up to `maxTokens` and gains
   * `refillRatePerSec` a second, fractions included: `1 / 30` is one token
   * every thirty seconds.
   *
   * Each slot holds one number, the bucket's *theoretical arrival time* in
   * microseconds since the epoch (GCRA, the generic cell rate algorithm): the
   * moment it would be full again if nothing else arrived. A token is one
   * `interval` of that time, and a request is admitted while granting it
   * leaves the arrival time no more than `maxTokens` intervals ahead of now.
   * A slot never used holds 0, and any time not ahead of now reads as full.
   *
   * It replaces two 32-bit words, tokens and whole seconds, which dropped the
   * fraction of every refill under one token a second. A bucket refilling at
   * 0.5 a second, asked once a second while empty, computed 0.5, stored 0
   * and restarted its clock, so it never granted again while the client kept
   * asking (measured: a grant due after 2 s did not come in 120). One word is
   * also one compare-and-swap, where the pair could be torn between workers.
   *
   * `nowMs` is a seam for tests, in the manner of `sampleRateLimitLog`.
   */
  consumeToken(
    slot: number,
    maxTokens: number,
    refillRatePerSec: number,
    tokensRequested = 1,
    nowMs: number = Date.now(),
  ): boolean {
    if (slot < 0 || slot >= RATE_LIMIT_SLOT_COUNT) return false
    // Fail closed on limits that are not positive numbers: nothing is
    // admitted, rather than BigInt() throwing out of every request or a NaN
    // comparison letting every request through.
    if (!(maxTokens >= 1 && refillRatePerSec > 0 && tokensRequested >= 0)) {
      return false
    }

    const interval = tokenInterval(refillRatePerSec)
    const limit = Math.min(Math.floor(maxTokens) * interval, MAX_AHEAD_US)
    const cost = Math.floor(tokensRequested) * interval
    if (cost > limit) return false

    const now = Math.floor(nowMs) * 1000
    for (;;) {
      const raw = Atomics.load(this.rateLimits, slot)
      const stored = Number(raw)
      const next = (stored > now ? stored : now) + cost
      if (next - now > limit) return false
      if (
        Atomics.compareExchange(this.rateLimits, slot, raw, BigInt(next)) ===
        raw
      ) {
        return true
      }
    }
  }

  /**
   * Give back tokens a `consumeToken` call took, never past a full bucket.
   *
   * For a request that turned out not to count. The limiter has to charge
   * before routing, since admitting first and charging later lets a burst of
   * any size through at once, and whether a request was an asset is only
   * known once the handler that served it says so.
   */
  refundToken(
    slot: number,
    refillRatePerSec: number,
    tokens = 1,
    nowMs: number = Date.now(),
  ): void {
    if (slot < 0 || slot >= RATE_LIMIT_SLOT_COUNT) return
    if (!(refillRatePerSec > 0 && tokens > 0)) return

    const back = Math.floor(tokens) * tokenInterval(refillRatePerSec)
    const now = Math.floor(nowMs) * 1000
    for (;;) {
      const raw = Atomics.load(this.rateLimits, slot)
      const stored = Number(raw)
      // Already full: there is nothing to give back, and moving the arrival
      // time up to `now` would be a charge.
      if (stored <= now) return
      const next = Math.max(stored - back, now)
      if (
        Atomics.compareExchange(this.rateLimits, slot, raw, BigInt(next)) ===
        raw
      ) {
        return
      }
    }
  }

  allocateBuffer(length: number): { offset: number; view: Uint8Array } | null {
    if (length <= 0) return null
    const totalSize = Atomics.load(this.header, 1)
    while (true) {
      const currentOffset = Atomics.load(this.header, 2)
      if (currentOffset + length > totalSize) {
        return null
      }
      const newOffset = currentOffset + length
      if (
        Atomics.compareExchange(this.header, 2, currentOffset, newOffset) ===
        currentOffset
      ) {
        return {
          offset: currentOffset,
          view: new Uint8Array(this.buffer, currentOffset, length),
        }
      }
    }
  }

  getBufferView(offset: number, length: number): Uint8Array | null {
    const totalSize = Atomics.load(this.header, 1)
    if (offset < BUFFER_START_OFFSET || offset + length > totalSize) return null
    return new Uint8Array(this.buffer, offset, length)
  }
}
