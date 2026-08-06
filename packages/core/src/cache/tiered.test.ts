import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { Bakery } from '../core/bakery'
import {
  __detachCaches,
  __restoreCaches,
  closeCacheDb,
  db,
  flushAllCaches,
  TieredCache,
} from './tiered'

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

describe('TieredCache persistence', () => {
  // `has` and `getAccessedAt` read through dedicated projections rather than
  // the full-row `select`, so the disk path needs its own coverage: every test
  // above only ever hits the in-memory tier.
  const table = `test_persist_${Date.now()}`
  let cache: TieredCache<string, any>

  beforeAll(() => {
    cache = new TieredCache(table, {
      memoryThreshold: 50,
      flushInterval: undefined,
    })
  })

  afterAll(() => {
    cache.close()
  })

  test('a cache with no shouldPersist keeps values across a memory flush', () => {
    // `shouldPersist` is optional, and `!opts.shouldPersist?.(v)` is `true`
    // when it is absent — so commitKey took the *delete* branch and every
    // flush (and every memory eviction, which also commits) silently destroyed
    // the value. Absence of the option has to mean "persist everything".
    cache.set('keep-me', { n: 1 })
    cache.flushToDisk()
    cache.destroyMemoryAndFlush() // drops the memory tier

    expect(cache.get('keep-me')).toEqual({ n: 1 })
  })

  test('has() finds a key that lives only on disk', () => {
    cache.set('disk-only', { n: 2 })
    cache.flushToDisk()
    cache.destroyMemoryAndFlush()

    expect(cache.has('disk-only')).toBe(true)
    expect(cache.has('never-written')).toBe(false)
  })

  test('getAccessedAt() reads a timestamp for a key that lives only on disk', () => {
    cache.set('stamped', { n: 3 })
    cache.flushToDisk()
    cache.destroyMemoryAndFlush()

    expect(cache.getAccessedAt('stamped')).toBeGreaterThan(0)
    expect(cache.getAccessedAt('never-written')).toBeUndefined()
  })

  test('an explicit shouldPersist=false still removes the row', () => {
    const dropTable = `test_drop_${Date.now()}`
    const dropping = new TieredCache<string, any>(dropTable, {
      memoryThreshold: 50,
      flushInterval: undefined,
      shouldPersist: () => false,
    })

    dropping.set('transient', { n: 4 })
    dropping.flushToDisk()
    dropping.destroyMemoryAndFlush()

    expect(dropping.get('transient')).toBeUndefined()
    dropping.close()
  })

  test('flushAllToDisk honours shouldPersist, exactly as the interval flush does', () => {
    // The shutdown flush was the one write path that bypassed `commitKey` and
    // inserted every in-memory entry verbatim. Same cache, same predicate, two
    // different results depending on *how* it was flushed: the interval left
    // ["keeper"] on disk and the shutdown flush left ["junk", "keeper"]. For
    // the session tier the predicate is "has persisted keys or has data", so a
    // clean stop wrote up to a thousand empty sessions and inflated
    // `Session.count` until the 15-minute pruner ran.
    const table = `test_flushall_pred_${Date.now()}`
    const cache = new TieredCache<string, { keep: boolean }>(table, {
      memoryThreshold: 500,
      flushInterval: undefined,
      shouldPersist: value => value.keep,
    })

    cache.set('keeper', { keep: true })
    cache.set('junk', { keep: false })
    cache.flushAllToDisk()

    // Read the table directly: `get()` would answer from the memory tier and
    // never tell us what actually reached disk.
    const onDisk = (
      db.query(`SELECT key FROM ${table} ORDER BY key`).all() as {
        key: string
      }[]
    ).map(row => row.key)

    expect(onDisk).toEqual(['keeper'])
    cache.close()
  })
})

describe('cache shutdown', () => {
  /**
   * `Bakery.shutdownHooks` runs in registration order, and this module is
   * evaluated long before any plugin registers, so its hook is index 0. When
   * that hook also called `db.close()`, every plugin that writes on the way out
   * — analytics flushes page hits and a history delta through this same handle
   * — found the database shut and threw into a catch that swallowed it. Nothing
   * was logged and nothing was persisted.
   *
   * The registry is detached so this exercises the hook against a throwaway
   * cache instead of flushing and closing `Strings` and the session tier, which
   * every later test file in the run still needs.
   */
  test('the framework shutdown hook flushes but leaves the database open', () => {
    const saved = __detachCaches()
    const table = `test_hook_${Date.now()}`
    const probe = new TieredCache<string, any>(table, {
      memoryThreshold: 50,
      flushInterval: undefined,
    })

    try {
      probe.set('written-on-shutdown', { n: 1 })
      flushAllCaches()

      // Flushed…
      const rows = db.query(`SELECT key FROM ${table}`).all() as {
        key: string
      }[]
      expect(rows.map(r => r.key)).toEqual(['written-on-shutdown'])

      // …and the handle a plugin hook would write through is still usable.
      // With `db.close()` inside the hook this throws instead.
      expect(() => db.query('SELECT 1 AS ok').get()).not.toThrow()
    } finally {
      probe.close()
      __restoreCaches(saved)
    }
  })

  test('closing the database is a separate step, not a shutdown hook', () => {
    // Ordering is the whole fix: `runShutdownSequence()` calls `closeCacheDb()`
    // after `PluginHooks.onShutdown()`. If it were reachable through
    // `Bakery.shutdownHooks` it would run before the plugins again.
    expect(Bakery.shutdownHooks).toContain(flushAllCaches)
    expect(Bakery.shutdownHooks).not.toContain(closeCacheDb)
  })
})
