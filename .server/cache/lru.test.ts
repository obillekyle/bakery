import { describe, test, expect } from 'bun:test'
import { LRUCache } from './lru'

describe('LRUCache', () => {
  test('throws on invalid maxSize', () => {
    expect(() => new LRUCache(0)).toThrow()
    expect(() => new LRUCache(-1)).toThrow()
  })

  test('basic get/set', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBe(2)
  })

  test('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(3)
    expect(cache.get('missing')).toBeUndefined()
  })

  test('evicts least recently used when over maxSize', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('d', 4) // should evict 'a' (LRU)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('d')).toBe(4)
  })

  test('get reorders access (moves to end)', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    // access 'a' to make it recently used
    cache.get('a')
    cache.set('d', 4) // should evict 'b' (now LRU)
    expect(cache.get('a')).toBe(1)
    expect(cache.get('b')).toBeUndefined()
  })

  test('set on existing key reorders', () => {
    const cache = new LRUCache<string, number>(3)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.set('a', 10) // re-insert 'a', moves to end
    cache.set('d', 4) // should evict 'b'
    expect(cache.get('a')).toBe(10)
    expect(cache.get('b')).toBeUndefined()
  })

  test('maxSize of 1 keeps only one entry', () => {
    const cache = new LRUCache<number, string>(1)
    cache.set(1, 'a')
    cache.set(2, 'b')
    expect(cache.get(1)).toBeUndefined()
    expect(cache.get(2)).toBe('b')
  })

  test('extends Map', () => {
    const cache = new LRUCache<string, number>(5)
    expect(cache).toBeInstanceOf(Map)
    cache.set('x', 99)
    expect(cache.size).toBe(1)
  })
})
