import type { Statement } from 'bun:sqlite'
import { LRUCache } from '@server/cache/lru'
import { Bakery } from '@server/core/bakery'
import { cacheDb as db } from '@server/database/shared-cache'
import { Logger } from '@server/logger'

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

export class TieredCache<K extends string | number, V> {
  private memoryStore = new Map<K, CacheEntry<V>>()
  private dirtyKeys = new Set<K>()
  private flushTimer?: ReturnType<typeof setInterval>
  private opts: TieredCacheOptions<V>
  private tableName: string
  private stmt: Record<string, Statement>
  private stmtCache = new LRUCache<string, Statement>(
    import.meta.env.THREAD_WORKER ? 15 : 50,
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
    return this.stmt.select.get(String(key)) !== null
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
      this.stmt.select.get(String(key)) as Pick<DbRow, 'accessedAt'> | null
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
      } catch {}
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
      } catch {}
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
        orderBy = 'ORDER BY accessedAt' // Safe fallback prevents SQLite crash!
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
      for (const [key, entry] of this.memoryStore) {
        this.stmt.insert.run(
          String(key),
          JSON.stringify(entry.value),
          entry.accessedAt,
        )
      }
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
    if (!this.opts.shouldPersist?.(entry.value)) {
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
Bakery.onShutdown(() => {
  logger.log('Flushing caches and shutting down...', 'info')
  for (const cache of registry) {
    cache.flushAllToDisk()
    cache.close()
  }
  db.close()
  logger.log('Sync complete. Database closed cleanly.', 'info')
})
