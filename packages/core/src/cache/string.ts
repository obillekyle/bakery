import type { Statement } from 'bun:sqlite'
import { db, type Milliseconds, registerCache } from './tiered'

type StringEntry = { value: string; accessedAt: number }

class StringCache {
  private forwardMap = new Map<string, StringEntry>()
  private reverseMap = new Map<string, string>()
  private dirtyKeys = new Set<string>()
  private flushTimer?: ReturnType<typeof setInterval>
  private tableName: string
  private stmt: Record<string, Statement>

  constructor(tableId: string, flushIntervalMs?: Milliseconds) {
    this.tableName = tableId.replace(/[^a-zA-Z0-9_]/g, '')

    db.run(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        key TEXT PRIMARY KEY,
        value TEXT UNIQUE,
        accessedAt INTEGER
      )
    `)
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_${this.tableName}_value ON ${this.tableName}(value)`,
    )

    // prettier-ignore
    this.stmt = {
      insert: db.prepare(
        `INSERT OR REPLACE INTO ${this.tableName} (key, value, accessedAt) VALUES (?, ?, ?)`,
      ),
      delete: db.prepare(`DELETE FROM ${this.tableName} WHERE key = ?`),
      byKey: db.prepare(
        `SELECT value, accessedAt FROM ${this.tableName} WHERE key = ?`,
      ),
      byVal: db.prepare(
        `SELECT key, accessedAt FROM ${this.tableName} WHERE value = ?`,
      ),
    }

    if (flushIntervalMs !== undefined) {
      this.flushTimer = setInterval(() => this.flushToDisk(), flushIntervalMs)
    }

    registerCache(this)
  }

  set(key: string, value: string): void {
    const existingVal = this.forwardMap.get(key)?.value
    const existingKey = this.reverseMap.get(value)

    if (existingVal === value) {
      // already mapped
    } else if (existingKey !== undefined && existingKey !== key) {
      throw new Error(
        `Collision! Value '${value}' is already mapped to key '${existingKey}'`,
      )
    } else if (existingVal !== undefined && existingVal !== value) {
      this.reverseMap.delete(existingVal)
    }

    const now = Date.now()
    this.forwardMap.set(key, { value, accessedAt: now })
    this.reverseMap.set(value, key)
    this.dirtyKeys.add(key)
  }

  getValue(key: string): string | undefined {
    if (this.forwardMap.has(key)) {
      const entry = this.forwardMap.get(key)!
      entry.accessedAt = Date.now()
      return entry.value
    }

    const row = this.stmt.byKey.get(key) as StringEntry | null
    if (!row) return undefined

    this.forwardMap.set(key, { value: row.value, accessedAt: Date.now() })
    this.reverseMap.set(row.value, key)
    return row.value
  }

  getKey(value: string): string | undefined {
    if (this.reverseMap.has(value)) {
      const key = this.reverseMap.get(value)!
      this.forwardMap.get(key)!.accessedAt = Date.now()
      return key
    }

    const row = this.stmt.byVal.get(value) as {
      key: string
      accessedAt: number
    } | null
    if (!row) return undefined

    this.forwardMap.set(row.key, { value, accessedAt: Date.now() })
    this.reverseMap.set(value, row.key)
    return row.key
  }

  deleteByKey(key: string): boolean {
    const entry = this.forwardMap.get(key)

    if (entry) {
      this.reverseMap.delete(entry.value)
      this.forwardMap.delete(key)
    }

    this.dirtyKeys.delete(key)
    const info = this.stmt.delete.run(key)
    return entry !== undefined || info.changes > 0
  }

  flushToDisk(): void {
    if (this.dirtyKeys.size === 0) return
    const keys = new Set(this.dirtyKeys)
    this.dirtyKeys.clear()
    db.transaction(() => {
      for (const key of keys) {
        const entry = this.forwardMap.get(key)
        if (!entry) continue
        this.stmt.insert.run(key, entry.value, entry.accessedAt)
      }
    })()
  }

  flushAllToDisk(): void {
    if (this.forwardMap.size === 0) return
    db.transaction(() => {
      for (const [key, entry] of this.forwardMap) {
        this.stmt.insert.run(key, entry.value, entry.accessedAt)
      }
      this.dirtyKeys.clear()
    })()
  }

  close(): void {
    clearInterval(this.flushTimer)
    this.flushTimer = undefined
    this.forwardMap.clear()
    this.reverseMap.clear()
  }

  [Symbol.dispose](): void {
    this.close()
  }
}

export const Strings = new StringCache('string-cache', 30 * 60 * 1000)
