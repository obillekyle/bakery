import type { Statement } from 'bun:sqlite'
import { LRUCache } from './lru'
import { Bakery } from '../core/bakery'
import { cacheDb as db } from './shared-db'
import { Logger } from '../logger'

export { db }

export type Milliseconds = number & {}

export interface TieredCacheOptions<V> {
  memoryThreshold: number
  evictRatio?: number
  flushInterval?: Milliseconds
  reviver?: (data: any) => V
  shouldPersist?: (value: V) => boolean
}

type CacheEntry<V> = { value: V; accessedAt: number }

interface DbRow {
  key: string
  value: string
  accessedAt: number
}

interface DbCount {
  count: number
}

type Flushable = { flushAllToDisk(): void; close(): void }
const registry: Flushable[] = []
export function registerCache(cache: Flushable): void {
  registry.push(cache)
}

/**
 * Test seam — see `__setTestDb` / `__setTestConfig` for the pattern.
 *
 * Detaches the live registry so a test can drive `flushAllCaches()` against its
 * own caches without flushing and closing the process's real ones (`Strings`,
 * the session tier), which every later test file in the run still needs.
 * Returns what it removed; hand it back to `__restoreCaches`.
 */
export function __detachCaches(): Flushable[] {
  return registry.splice(0, registry.length)
}

export function __restoreCaches(caches: Flushable[]): void {
  registry.length = 0
  registry.push(...caches)
}

export class TieredCache<K extends string | number, V> {
  private memoryStore = new Map<K, CacheEntry<V>>()
  private dirtyKeys = new Set<K>()
  private flushTimer?: ReturnType<typeof setInterval>
  private opts: TieredCacheOptions<V>
  private tableName: string
  private stmt: Record<string, Statement>
  private stmtCache = new LRUCache<string, Statement>(
    import.meta.env.THREAD_WORKER ? 15 : 50,
    // An evicted statement still holds a native handle; close() only finalizes
    // whatever survived to the end.
    (_sql, stmt) => {
      try {
        stmt.finalize()
      } catch {
        // Already finalized, or its database is closed. Either way the native
        // handle this eviction exists to release is gone.
      }
    },
  )

  constructor(tableId: string, options: TieredCacheOptions<V>) {
    this.tableName = tableId.replace(/[^a-zA-Z0-9_]/g, '')
    const scaledThreshold = Math.max(
      50,
      Math.floor(
        options.memoryThreshold / (import.meta.env.THREAD_WORKER ? 4 : 1),
      ),
    )
    this.opts = {
      evictRatio: 0.1,
      flushInterval: 10000,
      ...options,
      memoryThreshold: scaledThreshold,
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT,
        accessedAt INTEGER
      )
    `)

    // prettier-ignore
    this.stmt = {
      insert: db.prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key, value, accessedAt) VALUES (?, ?, ?)`,
      ),
      delete: db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`),
      select: db.prepare(
        `SELECT value, accessedAt FROM ${this.tableName} WHERE key = ?`,
      ),
      // `has` and `getAccessedAt` used `select`, which drags the whole JSON
      // blob out of SQLite and marshals it into JS only to be thrown away.
      // Projecting just what each needs is O(1) instead of O(value).
      exists: db.prepare(`SELECT 1 AS present FROM ${this.tableName} WHERE key = ?`),
      accessedAt: db.prepare(
        `SELECT accessedAt FROM ${this.tableName} WHERE key = ?`,
      ),
      keys: db.prepare(`SELECT key FROM ${this.tableName}`),
      all: db.prepare(`SELECT key, value FROM ${this.tableName}`),
      prune: db.prepare(`DELETE FROM ${this.tableName} WHERE accessedAt < ?`),
      expired: db.prepare(
        `SELECT key FROM ${this.tableName} WHERE accessedAt < ?`,
      ),
      expiredParam: db.prepare(
        `SELECT key FROM ${this.tableName} WHERE accessedAt < ? AND (json_array_length(value, ?) IS NULL OR json_array_length(value, ?) = 0)`,
      ),
      pruneParam: db.prepare(
        `DELETE FROM ${this.tableName} WHERE accessedAt < ? AND (json_array_length(value, ?) IS NULL OR json_array_length(value, ?) = 0)`,
      ),
      count: db.prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`),
    }

    if (this.opts.flushInterval !== undefined) {
      this.flushTimer = setInterval(
        () => this.flushToDisk(),
        this.opts.flushInterval,
      )
    }

    registerCache(this)
  }

  get count(): number {
    return (this.stmt.count.get() as DbCount | null)?.count ?? 0
  }

  get memorySize(): number {
    return this.memoryStore.size
  }

  get isDirty(): boolean {
    return this.dirtyKeys.size > 0
  }

  has(key: K): boolean {
    if (this.memoryStore.has(key)) return true
    return this.stmt.exists.get(String(key)) !== null
  }

  get(key: K): V | undefined {
    if (this.memoryStore.has(key)) {
      const entry = this.memoryStore.get(key)!
      entry.accessedAt = Date.now()
      this.memoryStore.delete(key)
      this.memoryStore.set(key, entry)
      return entry.value
    }

    const row = this.stmt.select.get(String(key)) as Pick<
      DbRow,
      'value' | 'accessedAt'
    > | null
    if (!row) return undefined

    const parsed = JSON.parse(row.value)
    const value: V = this.opts.reviver ? this.opts.reviver(parsed) : parsed

    this.memoryStore.delete(key)
    this.memoryStore.set(key, { value, accessedAt: Date.now() })
    this.dirtyKeys.delete(key)
    this.enforceMemoryLimit()

    return value
  }

  set(key: K, value: V): this {
    this.memoryStore.delete(key)
    this.memoryStore.set(key, { value, accessedAt: Date.now() })
    this.dirtyKeys.add(key)
    this.enforceMemoryLimit()
    return this
  }

  delete(key: K): boolean {
    const fromRAM = this.memoryStore.delete(key)
    this.dirtyKeys.delete(key)
    const info = this.stmt.delete.run(String(key))
    return fromRAM || info.changes > 0
  }

  getAccessedAt(key: K): number | undefined {
    if (this.memoryStore.has(key)) return this.memoryStore.get(key)!.accessedAt
    return (
      this.stmt.accessedAt.get(String(key)) as Pick<DbRow, 'accessedAt'> | null
    )?.accessedAt
  }

  prune(maxAgeMs: number, ignoreJsonArrayPath?: string): number {
    const cutoff = Date.now() - maxAgeMs

    const expired: { key: string }[] = ignoreJsonArrayPath
      ? (this.stmt.expiredParam.all(
          cutoff,
          ignoreJsonArrayPath,
          ignoreJsonArrayPath,
        ) as any)
      : (this.stmt.expired.all(cutoff) as any)

    for (const { key } of expired) {
      this.memoryStore.delete(key as K)
      this.dirtyKeys.delete(key as K)
    }

    const info = ignoreJsonArrayPath
      ? this.stmt.pruneParam.run(
          cutoff,
          ignoreJsonArrayPath,
          ignoreJsonArrayPath,
        )
      : this.stmt.prune.run(cutoff)

    return info.changes
  }

  exceedsMemoryLimit(): boolean {
    return this.memoryStore.size > this.opts.memoryThreshold
  }

  *keys(): IterableIterator<K> {
    const seen = new Set<K>()
    for (const key of this.memoryStore.keys()) {
      yield key
      seen.add(key)
    }
    for (const row of this.stmt.keys.iterate() as IterableIterator<{
      key: string
    }>) {
      const key = row.key as K
      if (!seen.has(key)) yield key
    }
  }

  *values(): IterableIterator<V> {
    const seen = new Set<K>()
    for (const [key, entry] of this.memoryStore) {
      yield entry.value
      seen.add(key)
    }
    for (const row of this.stmt.all.iterate() as IterableIterator<DbRow>) {
      if (seen.has(row.key as K)) continue
      try {
        const parsed = JSON.parse(row.value)
        yield this.opts.reviver ? this.opts.reviver(parsed) : parsed
      } catch {
        // Skip a corrupt row rather than aborting iteration over the rest of
        // the cache. The cache is disposable; one bad entry is not worth a throw.
      }
    }
  }

  *entries(): IterableIterator<[K, V]> {
    const seen = new Set<K>()
    for (const [key, entry] of this.memoryStore) {
      yield [key, entry.value]
      seen.add(key)
    }
    for (const row of this.stmt.all.iterate() as IterableIterator<DbRow>) {
      if (seen.has(row.key as K)) continue
      try {
        const parsed = JSON.parse(row.value)
        const value: V = this.opts.reviver ? this.opts.reviver(parsed) : parsed
        yield [row.key as K, value]
      } catch {
        // As above: a corrupt row is skipped, not fatal to the iteration.
      }
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries()
  }

  private getOrPrepareStmt(sql: string): Statement {
    let stmt = this.stmtCache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      this.stmtCache.set(sql, stmt)
    }
    return stmt
  }
  search(options: {
    search?: string
    page: number
    pageSize: number
    sortBy: string
    sortOrder: 'ASC' | 'DESC'
  }): {
    rows: V[]
    totalRows: number
    page: number
    pageSize: number
    totalPages: number
  } {
    this.flushToDiskForSearch()

    const pattern = options.search ? `%${options.search}%` : ''
    const where = pattern ? 'WHERE key LIKE ? OR LOWER(value) LIKE ?' : ''
    const params: any[] = pattern ? [pattern, pattern] : []

    let orderBy = ''
    switch (options.sortBy) {
      case 'id':
        orderBy = 'ORDER BY key'
        break
      case 'keys':
        orderBy = `ORDER BY json_array_length(value, '$.persistKeys')`
        break
      case 'created':
      case 'accessed':
      case 'match':
        orderBy = 'ORDER BY accessedAt'
        break
      default:
        orderBy = 'ORDER BY accessedAt'
    }

    const dir = options.sortOrder === 'ASC' ? 'ASC' : 'DESC'
    orderBy += ` ${dir}, key ${dir}`

    const countStmt = this.getOrPrepareStmt(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${where}`,
    )
    const totalRows = (countStmt.get(...params) as DbCount | null)?.count ?? 0

    const totalPages = Math.max(1, Math.ceil(totalRows / options.pageSize))
    const page = Math.min(options.page, totalPages)
    const offset = Math.max(0, (page - 1) * options.pageSize)

    const dataStmt = this.getOrPrepareStmt(
      `SELECT value FROM ${this.tableName} ${where} ${orderBy} LIMIT ? OFFSET ?`,
    )
    const rows = dataStmt.all(...params, options.pageSize, offset) as Pick<
      DbRow,
      'value'
    >[]

    return {
      rows: rows.map(r => {
        const parsed = JSON.parse(r.value)
        return this.opts.reviver ? this.opts.reviver(parsed) : parsed
      }),
      totalRows,
      page,
      pageSize: options.pageSize,
      totalPages,
    }
  }

  destroyMemoryAndFlush(): void {
    this.flushToDisk()
    this.memoryStore.clear()
  }

  flushToDisk(): void {
    if (this.dirtyKeys.size === 0) return
    const keys = new Set(this.dirtyKeys)
    this.dirtyKeys.clear()
    db.transaction(() => {
      for (const key of keys) this.commitKey(key)
    })()
  }

  flushAllToDisk(): void {
    if (this.memoryStore.size === 0) return
    db.transaction(() => {
      // Through `commitKey`, not a raw insert. This is the shutdown flush, and
      // it used to be the one write path that ignored `shouldPersist` — so the
      // interval flush and eviction dropped a non-persisting entry while a
      // clean stop wrote it. For the session tier that predicate is "has
      // persisted keys or has data", so every shutdown wrote up to a thousand
      // empty sessions, which then inflated `Session.count` (read by the
      // dashboard and the analytics gauge) until the 15-minute pruner caught
      // up.
      for (const key of this.memoryStore.keys()) this.commitKey(key)
      this.dirtyKeys.clear()
    })()
  }

  private flushToDiskForSearch(): void {
    if (this.dirtyKeys.size === 0) return
    const keys = new Set(this.dirtyKeys)
    this.dirtyKeys.clear()
    db.transaction(() => {
      for (const key of keys) {
        const entry = this.memoryStore.get(key)
        if (!entry) continue
        this.stmt.insert.run(
          String(key),
          JSON.stringify(entry.value),
          entry.accessedAt,
        )
      }
    })()
  }

  close(): void {
    clearInterval(this.flushTimer)
    this.flushTimer = undefined
    for (const stmt of this.stmtCache.values()) stmt.finalize()
    this.stmtCache.clear()
  }

  [Symbol.dispose](): void {
    this.close()
  }

  private commitKey(key: K): void {
    const entry = this.memoryStore.get(key)
    if (!entry) return
    // `shouldPersist?.(v)` is `undefined` when the option is absent, and
    // `!undefined` is `true` — so a cache configured without a predicate took
    // the delete branch for every key. Since `enforceMemoryLimit` commits as
    // it evicts, that made eviction destroy the value rather than demote it
    // to disk. Absence of the option means "persist everything".
    const shouldPersist = this.opts.shouldPersist
    if (shouldPersist && !shouldPersist(entry.value)) {
      this.stmt.delete.run(String(key))
    } else {
      this.stmt.insert.run(
        String(key),
        JSON.stringify(entry.value),
        entry.accessedAt,
      )
    }
  }

  private enforceMemoryLimit(): void {
    if (!this.exceedsMemoryLimit()) return

    const count = Math.floor(
      this.opts.memoryThreshold * (this.opts.evictRatio ?? 0.1),
    )
    const toEvict: K[] = []
    for (const key of this.memoryStore.keys()) {
      if (toEvict.length >= count) break
      toEvict.push(key)
    }

    db.transaction(() => {
      for (const key of toEvict) {
        this.commitKey(key)
        this.memoryStore.delete(key)
        this.dirtyKeys.delete(key)
      }
    })()
  }
}

const logger = new Logger('tiered-cache')

/**
 * Flush every registered cache to disk and release its timers and statements.
 *
 * Registered as a `Bakery.shutdownHooks` entry, which runs *before*
 * `PluginHooks.onShutdown()`. It deliberately does **not** close the shared
 * database: this hook is registered at module-evaluation time and therefore
 * sits at index 0, while a plugin's shutdown hook is registered later during
 * plugin setup. Closing the handle here invalidated it for every plugin that
 * writes on the way out — the analytics flush bound the same `cacheDb`, so
 * every statement threw into an outer catch and up to a minute of page hits
 * plus the whole history delta was discarded on every clean stop, silently.
 *
 * `closeCacheDb()` is the separate final step; `runShutdownSequence()` in the
 * CLI calls it after the plugin hooks.
 */
export function flushAllCaches(): void {
  logger.log('Flushing caches and shutting down...', 'info')
  for (const cache of registry) {
    cache.flushAllToDisk()
    cache.close()
  }
}

let cacheDbClosed = false

/** Close the shared cache database. Must run after every writer is done. */
export function closeCacheDb(): void {
  if (cacheDbClosed) return
  cacheDbClosed = true
  db.close()
  logger.log('Sync complete. Database closed cleanly.', 'info')
}

Bakery.onShutdown(flushAllCaches)
