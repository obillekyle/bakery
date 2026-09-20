const HEADER_INT_COUNT = 16
const COUNTERS_INT_COUNT = 256
const RATE_LIMIT_SLOT_COUNT = 1024
const HEADER_BYTES = HEADER_INT_COUNT * 4
const COUNTERS_BYTES = COUNTERS_INT_COUNT * 4
const RATE_LIMIT_BYTES = RATE_LIMIT_SLOT_COUNT * 2 * 4
const BUFFER_START_OFFSET = HEADER_BYTES + COUNTERS_BYTES + RATE_LIMIT_BYTES

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
  rateLimits!: Int32Array

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
      this.rateLimits = new Int32Array(
        this.buffer,
        HEADER_BYTES + COUNTERS_BYTES,
        RATE_LIMIT_SLOT_COUNT * 2,
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
    this.rateLimits = new Int32Array(
      this.buffer,
      HEADER_BYTES + COUNTERS_BYTES,
      RATE_LIMIT_SLOT_COUNT * 2,
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

  consumeToken(
    slot: number,
    maxTokens: number,
    refillRatePerSec: number,
    tokensRequested = 1,
  ): boolean {
    if (slot < 0 || slot >= RATE_LIMIT_SLOT_COUNT) return false
    const tokenIndex = slot * 2
    const timeIndex = slot * 2 + 1

    const nowSec = Math.floor(Date.now() / 1000)

    while (true) {
      const currentTokens = Atomics.load(this.rateLimits, tokenIndex)
      const lastTime = Atomics.load(this.rateLimits, timeIndex)

      if (lastTime === 0 && currentTokens === 0) {
        const initTokens = Math.max(0, maxTokens - tokensRequested)
        if (
          Atomics.compareExchange(this.rateLimits, timeIndex, 0, nowSec) === 0
        ) {
          Atomics.store(this.rateLimits, tokenIndex, initTokens)
          return tokensRequested <= maxTokens
        }
        continue
      }

      let availableTokens = currentTokens
      const elapsed = Math.max(0, nowSec - lastTime)
      if (elapsed > 0) {
        availableTokens = Math.min(
          maxTokens,
          currentTokens + elapsed * refillRatePerSec,
        )
      }

      if (availableTokens < tokensRequested) {
        if (elapsed > 0) {
          Atomics.compareExchange(this.rateLimits, timeIndex, lastTime, nowSec)
          Atomics.compareExchange(
            this.rateLimits,
            tokenIndex,
            currentTokens,
            availableTokens,
          )
        }
        return false
      }

      const newTokens = availableTokens - tokensRequested
      if (
        Atomics.compareExchange(
          this.rateLimits,
          tokenIndex,
          currentTokens,
          newTokens,
        ) === currentTokens
      ) {
        if (elapsed > 0) {
          Atomics.compareExchange(this.rateLimits, timeIndex, lastTime, nowSec)
        }
        return true
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
