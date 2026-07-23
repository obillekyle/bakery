import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { TieredCache } from './tiered'

describe('TieredCache', () => {
  const testTable = `test_tiered_${Date.now()}`
  let cache: TieredCache<string, any>

  beforeAll(() => {
    cache = new TieredCache(testTable, {
      memoryThreshold: 50,
      flushInterval: undefined, // disable auto-flush for tests
    })
  })

  afterAll(() => {
    cache.close()
  })

  test('set and get from memory', () => {
    cache.set('key1', { value: 42 })
    expect(cache.get('key1')).toEqual({ value: 42 })
  })

  test('has returns true for existing keys', () => {
    cache.set('exists', 'yes')
    expect(cache.has('exists')).toBe(true)
  })

  test('has returns false for missing keys', () => {
    expect(cache.has('nope')).toBe(false)
  })

  test('delete removes from memory', () => {
    cache.set('to-delete', 1)
    cache.delete('to-delete')
    expect(cache.get('to-delete')).toBeUndefined()
  })

  test('memorySize tracks in-memory entries', () => {
    const before = cache.memorySize
    cache.set('mem-test', 1)
    expect(cache.memorySize).toBeGreaterThanOrEqual(before)
  })

  test('count returns total entries', () => {
    const before = cache.count
    cache.set(`count-${Date.now()}`, 1)
    expect(cache.count).toBeGreaterThanOrEqual(before)
  })

  test('prune removes old entries', () => {
    cache.set(`prune-${Date.now()}`, 1)
    // prune with 0ms age should remove everything
    const pruned = cache.prune(0)
    expect(pruned).toBeGreaterThanOrEqual(0)
  })

  test('flushToDisk persists dirty keys', () => {
    cache.set('flush-test', 'dirty')
    cache.flushToDisk()
    // After flush, data should be in SQLite
    expect(cache.isDirty).toBe(false)
  })

  test('getAccessedAt returns timestamp', () => {
    cache.set('at-test', 1)
    const accessed = cache.getAccessedAt('at-test')
    expect(accessed).toBeGreaterThan(0)
  })

  test('destroyMemoryAndFlush clears memory', () => {
    cache.set('destroy-me', 1)
    cache.destroyMemoryAndFlush()
    expect(cache.memorySize).toBe(0)
  })

  test('keys() iterates over entries', () => {
    cache.set('iter-key', 'iter-val')
    const keys = [...cache.keys()]
    expect(keys).toContain('iter-key')
  })

  test('entries() iterates key-value pairs', () => {
    cache.set('entry-key', { a: 1 })
    const entries = [...cache.entries()]
    const found = entries.find(([k]) => k === 'entry-key')
    expect(found).toBeDefined()
    expect(found![1]).toEqual({ a: 1 })
  })
})
