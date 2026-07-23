import type Database from 'bun:sqlite'
import { cacheDb } from '@server/database/shared-cache'
import {
  BOOT_MAX_ITEMS,
  history1d,
  history1h,
  history1m,
  history7d,
  history30d,
  pageHitsLog,
  pageHitsMap,
  RETENTION_MS,
} from './core'
import { timescaleToMs } from './timescale'
import type { AnalyticsSnapshot } from './types'

let db: Database | null = null
let lastSavedPageHitTs = 0

let stmtInsertPageHit: ReturnType<Database['prepare']> | null = null
let stmtUpsertCore: ReturnType<Database['prepare']> | null = null
let stmtSelectCore: ReturnType<Database['prepare']> | null = null
let stmtSelectPageHits: ReturnType<Database['prepare']> | null = null
let stmtDeletePageHits: ReturnType<Database['prepare']> | null = null

function initDbInstance() {
  if (db) return db
  db = cacheDb
  try {
    db.run(`CREATE TABLE IF NOT EXISTS page_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      path TEXT NOT NULL
    );`)
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_page_hits_timestamp ON page_hits(timestamp);',
    )
    db.run('CREATE INDEX IF NOT EXISTS idx_page_hits_path ON page_hits(path);')

    db.run(`CREATE TABLE IF NOT EXISTS core (
      key TEXT PRIMARY KEY,
      value JSON
    );`)
  } catch (e) {
    db = null
    throw e
  }
  return db
}

export function initSqliteStorage() {
  try {
    return Promise.resolve(initDbInstance())
  } catch (e) {
    console.error('analytics sqlite init error', e)
    return Promise.resolve(null)
  }
}

export function getDb(): Database | null {
  return db || null
}

export default {
  initSqliteStorage,
  getDb,
}

export async function saveAnalyticsData(_cacheBase: string) {
  try {
    await initSqliteStorage()
    const d = getDb()
    if (!d) return

    if (!stmtDeletePageHits)
      stmtDeletePageHits = d.prepare(
        'DELETE FROM page_hits WHERE timestamp < ?',
      )
    if (!stmtInsertPageHit)
      stmtInsertPageHit = d.prepare(
        'INSERT INTO page_hits(timestamp,path) VALUES(?,?)',
      )
    if (!stmtUpsertCore)
      stmtUpsertCore = d.prepare(
        'INSERT OR REPLACE INTO core(key,value) VALUES(?,?)',
      )

    const now = Date.now()
    const pruneBefore = now - RETENTION_MS
    try {
      stmtDeletePageHits.run(pruneBefore)
    } catch {}

    if (pageHitsLog.length > 0) {
      const tx = d.transaction((rows: [number, string][]) => {
        for (const r of rows) stmtInsertPageHit!.run(r[0], r[1])
      })

      const newHits = pageHitsLog.filter(p => p.timestamp > lastSavedPageHitTs)

      if (newHits.length > 0) {
        const rows: [number, string][] = newHits.map(p => [p.timestamp, p.path])
        const BATCH = 1000
        for (let i = 0; i < rows.length; i += BATCH) {
          tx(rows.slice(i, i + BATCH))
        }

        lastSavedPageHitTs = newHits[newHits.length - 1].timestamp
      }
    }

    const coreData: any = {
      history1m: history1m as AnalyticsSnapshot[],
      history1h: history1h as AnalyticsSnapshot[],
      history1d: history1d as AnalyticsSnapshot[],
      history7d: history7d as AnalyticsSnapshot[],
      history30d: history30d as AnalyticsSnapshot[],
      pageHits: Array.from(pageHitsMap.entries()),
    }
    try {
      stmtUpsertCore.run('core', JSON.stringify(coreData))
    } catch {}
  } catch {
    // ignore
  }
}

export async function loadAnalyticsData(
  _cacheBase: string,
  timescale: string = '1d',
) {
  try {
    await initSqliteStorage()
    const d = getDb()
    if (!d) return { coreData: null, pageHitsRaw: null } as any

    if (!stmtSelectCore)
      stmtSelectCore = d.prepare('SELECT value FROM core WHERE key = ?')
    if (!stmtSelectPageHits)
      stmtSelectPageHits = d.prepare(
        'SELECT timestamp, path FROM page_hits WHERE timestamp >= ? ORDER BY timestamp DESC LIMIT ?',
      )

    let coreData: any = null
    try {
      const row: any = stmtSelectCore.get('core')
      if (row.value) {
        coreData =
          typeof row.value === 'string' ? JSON.parse(row.value) : row.value
      }
    } catch {
      coreData = null
    }

    const windowMs = timescaleToMs(timescale) || 24 * 3600 * 1000
    const now = Date.now()
    const minTs = now - windowMs
    let pageHitsRaw: any[] = []
    try {
      const rows: any[] = stmtSelectPageHits.all(minTs, BOOT_MAX_ITEMS) || []
      // Reverse so they are in ascending chronological order
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]
        pageHitsRaw.push({ timestamp: r.timestamp, path: r.path })
      }

      try {
        const maxRow: any = d
          .prepare('SELECT MAX(timestamp) as maxTs FROM page_hits')
          .get()
        if (maxRow && typeof maxRow.maxTs === 'number') {
          lastSavedPageHitTs = maxRow.maxTs
        } else if (pageHitsRaw.length > 0) {
          lastSavedPageHitTs = pageHitsRaw[pageHitsRaw.length - 1].timestamp
        }
      } catch {
        if (pageHitsRaw.length > 0) {
          lastSavedPageHitTs = pageHitsRaw[pageHitsRaw.length - 1].timestamp
        }
      }
    } catch {
      pageHitsRaw = null as any
    }

    return { coreData, pageHitsRaw } as any
  } catch {
    return { coreData: null, pageHitsRaw: null } as any
  }
}
