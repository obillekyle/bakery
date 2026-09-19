import { describe, expect, test } from 'bun:test'
import { COUNTER_SLOTS, SharedMemoryPool } from './shared-pool'

describe('SharedMemoryPool', () => {
  test('constructs with default size', () => {
    const pool = new SharedMemoryPool()
    expect(pool.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(pool.header).toBeInstanceOf(Int32Array)
    expect(pool.counters).toBeInstanceOf(Int32Array)
    expect(pool.rateLimits).toBeInstanceOf(Int32Array)
  })

  test('the default allocation is the layout, not a megabyte', () => {
    // It was `1024 * 1024`, of which 9,280 bytes were the header, the counters
    // and the rate-limit slots. The rest was a `dataPool` region whose only
    // reader anywhere was the assertion that used to sit in the test above.
    const pool = new SharedMemoryPool()
    expect(pool.buffer.byteLength).toBe(9280)
    expect(pool.buffer.byteLength).toBeLessThan(1024 * 1024)
  })

  test('a larger size is still honoured', () => {
    // `threads.ts` shares one buffer across workers and `bind` reads the size
    // out of the header, so a master that asks for more still works.
    const pool = new SharedMemoryPool(64 * 1024)
    expect(pool.buffer.byteLength).toBe(64 * 1024)
    expect(Atomics.load(pool.header, 1)).toBe(64 * 1024)

    const adopted = new SharedMemoryPool(pool.buffer)
    expect(adopted.buffer.byteLength).toBe(64 * 1024)
  })

  test('a size below the layout is raised to it', () => {
    const pool = new SharedMemoryPool(16)
    expect(pool.buffer.byteLength).toBe(9280)
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
      expect(pool.consumeToken(9999, 10, 1)).toBe(false)
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
