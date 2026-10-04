import { describe, expect, test } from 'bun:test'
import {
  COUNTER_SLOTS,
  RATE_LIMIT_SLOT_COUNT,
  SharedMemoryPool,
} from './shared-pool'

/** The layout: a 64-byte header, 1 KB of counters, one 8-byte word per bucket. */
const LAYOUT_BYTES = 64 + 1024 + RATE_LIMIT_SLOT_COUNT * 8

describe('SharedMemoryPool', () => {
  test('constructs with default size', () => {
    const pool = new SharedMemoryPool()
    expect(pool.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(pool.header).toBeInstanceOf(Int32Array)
    expect(pool.counters).toBeInstanceOf(Int32Array)
    expect(pool.rateLimits).toBeInstanceOf(BigInt64Array)
  })

  test('the default allocation is the layout, not a megabyte', () => {
    // It was `1024 * 1024`, of which 9,280 bytes were the header, the counters
    // and the rate-limit slots. The rest was a `dataPool` region whose only
    // reader anywhere was the assertion that used to sit in the test above.
    // The buckets have since grown to 16384 words (see RATE_LIMIT_SLOT_COUNT),
    // which is 132,160 bytes, every one of them read.
    const pool = new SharedMemoryPool()
    expect(pool.buffer.byteLength).toBe(LAYOUT_BYTES)
    expect(LAYOUT_BYTES).toBe(132_160)
    expect(pool.buffer.byteLength).toBeLessThan(1024 * 1024)
  })

  test('a larger size is still honored', () => {
    // `threads.ts` shares one buffer across workers and `bind` reads the size
    // out of the header, so a master that asks for more still works.
    const pool = new SharedMemoryPool(256 * 1024)
    expect(pool.buffer.byteLength).toBe(256 * 1024)
    expect(Atomics.load(pool.header, 1)).toBe(256 * 1024)

    const adopted = new SharedMemoryPool(pool.buffer)
    expect(adopted.buffer.byteLength).toBe(256 * 1024)
  })

  test('a size below the layout is raised to it', () => {
    const pool = new SharedMemoryPool(16)
    expect(pool.buffer.byteLength).toBe(LAYOUT_BYTES)
  })

  test('constructs from existing SharedArrayBuffer', () => {
    const pool1 = new SharedMemoryPool(1024 * 1024)
    const pool2 = new SharedMemoryPool(pool1.buffer)
    expect(pool2.buffer).toBe(pool1.buffer)
  })

  test('header magic is set to 0x42414b45', () => {
    const pool = new SharedMemoryPool(1024 * 1024)
    expect(Atomics.load(pool.header, 0)).toBe(0x42414b45)
  })

  describe('counters', () => {
    test('incrementCounter returns new value', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      const val = pool.incrementCounter(COUNTER_SLOTS.TOTAL_REQUESTS)
      expect(val).toBe(1)
    })

    test('incrementCounter with delta', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      pool.incrementCounter(COUNTER_SLOTS.TOTAL_REQUESTS, 5)
      expect(pool.getCounter(COUNTER_SLOTS.TOTAL_REQUESTS)).toBe(5)
    })

    test('decrementCounter decrements', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      pool.incrementCounter(COUNTER_SLOTS.ACTIVE_CONNECTIONS, 10)
      pool.decrementCounter(COUNTER_SLOTS.ACTIVE_CONNECTIONS, 3)
      expect(pool.getCounter(COUNTER_SLOTS.ACTIVE_CONNECTIONS)).toBe(7)
    })

    test('setCounter stores value', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      pool.setCounter(COUNTER_SLOTS.TOTAL_REQUESTS, 42)
      expect(pool.getCounter(COUNTER_SLOTS.TOTAL_REQUESTS)).toBe(42)
    })

    test('out of range slot returns 0', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.incrementCounter(-1)).toBe(0)
      expect(pool.incrementCounter(9999)).toBe(0)
    })
  })

  describe('rate limiting', () => {
    test('consumeToken allows first request', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.consumeToken(0, 10, 1)).toBe(true)
    })

    test('consumeToken denies when exhausted', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      for (let i = 0; i < 5; i++) {
        pool.consumeToken(0, 5, 1)
      }
      expect(pool.consumeToken(0, 5, 1)).toBe(false)
    })

    test('out of range slot returns false', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.consumeToken(-1, 10, 1)).toBe(false)
      expect(pool.consumeToken(RATE_LIMIT_SLOT_COUNT, 10, 1)).toBe(false)
    })

    // Every test below passes the clock in (the last argument), the way
    // `sampleRateLimitLog` takes its `now`, so none of them sleeps.
    const T0 = 1_800_000_000_000

    /** Drain a bucket of `max` at `t`, returning how many were granted. */
    function drain(
      pool: SharedMemoryPool,
      max: number,
      refill: number,
      t = T0,
    ) {
      let granted = 0
      while (pool.consumeToken(0, max, refill, 1, t)) granted++
      return granted
    }

    test('a burst of max is granted, then nothing until the refill', () => {
      const pool = new SharedMemoryPool()
      expect(drain(pool, 5, 1)).toBe(5)
      expect(pool.consumeToken(0, 5, 1, 1, T0 + 999)).toBe(false)
      expect(pool.consumeToken(0, 5, 1, 1, T0 + 1000)).toBe(true)
    })

    test('a refill below one a second still refills', () => {
      // The defect this layout replaced. Tokens lived in an Int32Array and
      // time in whole seconds, so at 0.5 a second a drained bucket asked once
      // a second computed 0.5 tokens, stored 0, and restarted its clock: it
      // never granted again for as long as the client kept asking. Measured
      // before the change, a grant expected after 2 s did not come in 120.
      // A sign-in rule of 10 a minute is exactly this shape.
      const pool = new SharedMemoryPool()
      drain(pool, 3, 0.5)
      expect(pool.consumeToken(0, 3, 0.5, 1, T0 + 1000)).toBe(false)
      expect(pool.consumeToken(0, 3, 0.5, 1, T0 + 2000)).toBe(true)
      expect(pool.consumeToken(0, 3, 0.5, 1, T0 + 3000)).toBe(false)
      expect(pool.consumeToken(0, 3, 0.5, 1, T0 + 4000)).toBe(true)
    })

    test('one token a minute comes back after a minute', () => {
      const pool = new SharedMemoryPool()
      drain(pool, 10, 1 / 60)
      for (let s = 1; s < 60; s++) {
        expect(pool.consumeToken(0, 10, 1 / 60, 1, T0 + s * 1000)).toBe(false)
      }
      expect(pool.consumeToken(0, 10, 1 / 60, 1, T0 + 60_000)).toBe(true)
    })

    test('tokens come back one interval apart, not in whole-second steps', () => {
      const pool = new SharedMemoryPool()
      drain(pool, 2, 4)
      expect(pool.consumeToken(0, 2, 4, 1, T0 + 249)).toBe(false)
      expect(pool.consumeToken(0, 2, 4, 1, T0 + 250)).toBe(true)
      expect(pool.consumeToken(0, 2, 4, 1, T0 + 499)).toBe(false)
      expect(pool.consumeToken(0, 2, 4, 1, T0 + 500)).toBe(true)
    })

    test('an idle bucket fills to max and no further', () => {
      const pool = new SharedMemoryPool()
      drain(pool, 3, 10)
      // An hour idle is worth 36,000 tokens at 10 a second; the bucket holds 3.
      expect(drain(pool, 3, 10, T0 + 3_600_000)).toBe(3)
    })

    test('refundToken gives a token back', () => {
      const pool = new SharedMemoryPool()
      drain(pool, 3, 1)
      pool.refundToken(0, 1, 1, T0)
      expect(pool.consumeToken(0, 3, 1, 1, T0)).toBe(true)
      expect(pool.consumeToken(0, 3, 1, 1, T0)).toBe(false)
    })

    test('a refund never fills a bucket past max', () => {
      const pool = new SharedMemoryPool()
      pool.consumeToken(0, 3, 1, 1, T0)
      for (let i = 0; i < 10; i++) pool.refundToken(0, 1, 1, T0)
      expect(drain(pool, 3, 1)).toBe(3)
    })

    test('a refund to a full bucket is a no-op, not a charge', () => {
      const pool = new SharedMemoryPool()
      pool.refundToken(0, 1, 1, T0)
      expect(drain(pool, 3, 1)).toBe(3)
    })

    test('two pools over one buffer share their buckets', () => {
      // What cluster mode relies on: threads.ts hands every worker the same
      // buffer, so a client cannot get max per worker.
      const a = new SharedMemoryPool()
      const b = new SharedMemoryPool(a.buffer)
      expect(drain(a, 4, 1)).toBe(4)
      expect(b.consumeToken(0, 4, 1, 1, T0)).toBe(false)
      b.refundToken(0, 1, 1, T0)
      expect(a.consumeToken(0, 4, 1, 1, T0)).toBe(true)
    })

    test('nonsense limits fail closed instead of throwing', () => {
      // The word is stored as a BigInt, and BigInt(NaN) throws, while a NaN
      // in a comparison answers false and would admit everything. A config
      // typo must turn into neither a 500 on every request nor an open door.
      for (const [max, refill] of [
        [0, 10],
        [Number.NaN, 10],
        [-5, 10],
        [5, 0],
        [5, Number.NaN],
        [5, -1],
      ]) {
        const pool = new SharedMemoryPool()
        expect(pool.consumeToken(0, max!, refill!, 1, T0)).toBe(false)
        expect(() => pool.refundToken(0, refill!, 1, T0)).not.toThrow()
      }
    })

    test('asking for more than max at once is refused', () => {
      const pool = new SharedMemoryPool()
      expect(pool.consumeToken(0, 3, 1, 4, T0)).toBe(false)
      expect(pool.consumeToken(0, 3, 1, 3, T0)).toBe(true)
    })
  })

  describe('buffer allocation', () => {
    test('allocateBuffer returns offset and view', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      const result = pool.allocateBuffer(100)
      expect(result).not.toBeNull()
      expect(result!.offset).toBeGreaterThan(0)
      expect(result!.view).toBeInstanceOf(Uint8Array)
      expect(result!.view.length).toBe(100)
    })

    test('allocateBuffer returns null for zero length', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.allocateBuffer(0)).toBeNull()
    })

    test('allocateBuffer returns null for negative length', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.allocateBuffer(-1)).toBeNull()
    })

    test('getBufferView returns view for valid range', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      const alloc = pool.allocateBuffer(10)
      expect(alloc).not.toBeNull()
      const view = pool.getBufferView(alloc!.offset, 10)
      expect(view).not.toBeNull()
      expect(view!.length).toBe(10)
    })

    test('getBufferView returns null for out of range', () => {
      const pool = new SharedMemoryPool(1024 * 1024)
      expect(pool.getBufferView(9999999, 100)).toBeNull()
    })
  })

  describe('bind', () => {
    test('binds new buffer and resets views', () => {
      const pool1 = new SharedMemoryPool(1024 * 1024)
      const pool2 = new SharedMemoryPool(2048)
      pool1.bind(pool2.buffer)
      expect(pool1.buffer).toBe(pool2.buffer)
    })
  })
})
