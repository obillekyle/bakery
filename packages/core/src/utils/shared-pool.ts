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
  buffer: SharedArrayBuffer
  header: Int32Array
  counters: Int32Array
  rateLimits: Int32Array
  dataPool: Uint8Array

  constructor(sizeOrBuffer: number | SharedArrayBuffer = 1024 * 1024) {
    if (typeof sizeOrBuffer === 'number') {
      const size = Math.max(sizeOrBuffer, BUFFER_START_OFFSET + 1024)
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
      this.dataPool = new Uint8Array(
        this.buffer,
        BUFFER_START_OFFSET,
        size - BUFFER_START_OFFSET,
      )

      Atomics.store(this.header, 0, 0x42414b45)
      Atomics.store(this.header, 1, size)
      Atomics.store(this.header, 2, BUFFER_START_OFFSET)
    } else {
      this.buffer = sizeOrBuffer
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
      const size = Atomics.load(this.header, 1) || this.buffer.byteLength
      this.dataPool = new Uint8Array(
        this.buffer,
        BUFFER_START_OFFSET,
        size - BUFFER_START_OFFSET,
      )
    }
  }

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
    const size = Atomics.load(this.header, 1) || this.buffer.byteLength
    this.dataPool = new Uint8Array(
      this.buffer,
      BUFFER_START_OFFSET,
      size - BUFFER_START_OFFSET,
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
