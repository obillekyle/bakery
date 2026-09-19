import type Database from 'bun:sqlite'
import { cacheDb } from '@bakery-framework/core/cache/shared-db'
import { errorMsg, pluginLog } from '@bakery-framework/core/logger'
import { Try } from '@bakery-framework/core/utils/common'
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
  snapshotTemps,
} from './core'
import { analyticsLog } from './log'
import { timescaleToMs } from './timescale'
import type { AnalyticsSnapshot } from './types'

/** Hard ceiling on persisted page hits, independent of RETENTION_MS. */
const MAX_PAGE_HIT_ROWS = 200_000

let db: Database | null = null
let lastSavedPageHitTs = 0

let stmtInsertPageHit: ReturnType<Database['prepare']> | null = null
let stmtUpsertCore: ReturnType<Database['prepare']> | null = null
let stmtSelectCore: ReturnType<Database['prepare']> | null = null
let stmtSelectPageHits: ReturnType<Database['prepare']> | null = null
let stmtDeletePageHits: ReturnType<Database['prepare']> | null = null

function ensureSchema(d: Database) {
  d.run(`CREATE TABLE IF NOT EXISTS page_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      path TEXT NOT NULL
    );`)
  d.run(
    'CREATE INDEX IF NOT EXISTS idx_page_hits_timestamp ON page_hits(timestamp);',
  )
  d.run('CREATE INDEX IF NOT EXISTS idx_page_hits_path ON page_hits(path);')

  d.run(`CREATE TABLE IF NOT EXISTS core (
      key TEXT PRIMARY KEY,
      value JSON
    );`)
}

function initDbInstance() {
  if (db) return db
  db = cacheDb
  try {
    ensureSchema(db)
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
    pluginLog.ANALYTICS_STORE_ERR({ error: errorMsg(e) })
    return Promise.resolve(null)
  }
}

export function getDb(): Database | null {
  return db || null
}

function resetStatements() {
  stmtInsertPageHit = null
  stmtUpsertCore = null
  stmtSelectCore = null
  stmtSelectPageHits = null
  stmtDeletePageHits = null
}

/**
 * Test seam (convention 9) for the storage handle.
 *
 * The real handle is `cacheDb`, which the whole process shares — closing it to
 * exercise a write failure would take every test file loaded afterwards with
 * it. The prepared statements are reset alongside, since they belong to the
 * connection they were compiled against.
 */
export function __setTestDb(instance: Database | null) {
  db = instance
  resetStatements()
  // Same schema the real handle gets. A test that injects an already-closed
  // handle to drive the failure path cannot have one, which is the point of
  // injecting it — hence `Try` rather than a throw.
  if (instance) Try(() => ensureSchema(instance))
}

export function __resetTestDb() {
  db = null
  resetStatements()
}

export default {
  initSqliteStorage,
  getDb,
}

/**
 * Write the page hits recorded since the last call, and nothing else.
 *
 * Split out of `saveAnalyticsData` so the two halves can run on different
 * schedules, because they cost very different amounts. Inserting a second of
 * hits is 1-4 ms; the full save, with its prune and its `core` upsert, is not.
 *
 * Measured across a minute of traffic at 1,000 req/s: inserting 60,000 rows in
 * transactions of 1,000 costs 89-115 ms, against 376 ms for the prune the
 * other half runs. So the insert was never what made the flush expensive - the
 * per-minute batch was blamed for a stall the prune was doing - and moving the
 * insert to the tick costs almost nothing while removing the one large batch
 * from the request thread entirely.
 *
 * Returns the number of rows written so a caller can tell "nothing to do" from
 * "could not write", which the void-returning original could not.
 *
 * **Throws rather than reporting.** Both callers already have a catch that
 * names the failure, and a catch here as well produced two log lines for one
 * closed database - which is worse than one, because the second looks like a
 * second failure. The rule that telemetry never takes down what it measures
 * is kept at the call sites, where it belongs.
 */
export async function flushPageHits(): Promise<number> {
  {
    await initSqliteStorage()
    const d = getDb()
    if (!d) return 0
    if (pageHitsLog.length === 0) return 0

    if (!stmtInsertPageHit)
      stmtInsertPageHit = d.prepare(
        'INSERT INTO page_hits(timestamp,path) VALUES(?,?)',
      )

    const newHits = pageHitsLog.filter(p => p.timestamp > lastSavedPageHitTs)
    if (newHits.length === 0) return 0

    const tx = d.transaction((rows: [number, string][]) => {
      for (const r of rows) stmtInsertPageHit!.run(r[0], r[1])
    })
    const rows: [number, string][] = newHits.map(p => [p.timestamp, p.path])
    const BATCH = 1000
    for (let i = 0; i < rows.length; i += BATCH) {
      tx(rows.slice(i, i + BATCH))
    }
    lastSavedPageHitTs = newHits[newHits.length - 1].timestamp
    return rows.length
  }
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

      // **Ask before deleting.** Age alone does not bound this table - a
      // crawler hitting distinct URLs can add millions of rows well inside the
      // retention window - so the row count is capped too. But the capping
      // statement is expensive in a way its shape hides: `NOT IN (SELECT rowid
      // ... ORDER BY timestamp DESC LIMIT n)` sorts and materialises n rowids
      // before it can decide that nothing needs deleting, and it ran on every
      // single flush.
      //
      // A `count(*)` is answered from the index. Measured on a 150k-row table,
      // three rounds each against a CPU-bound control that stayed flat:
      //
      //     prune as shipped          376 ms
      //     prune with this guard       5 ms
      //
      // Over the cap the delete still runs and still costs what it costs
      // (~360 ms at 250k rows), which is correct: that is the case where work
      // is genuinely required, and it is the rare one.
      const counted = d
        .query<{ n: number }, []>('SELECT count(*) AS n FROM page_hits')
        .get()
      if ((counted?.n ?? 0) > MAX_PAGE_HIT_ROWS) {
        d.run(
          `DELETE FROM page_hits WHERE rowid NOT IN (
             SELECT rowid FROM page_hits ORDER BY timestamp DESC LIMIT ${MAX_PAGE_HIT_ROWS}
           )`,
        )
      }
    } catch {
      // Pruning is best-effort. Failing to trim old rows must not abandon the
      // inserts below, which are the point of this call.
    }

    // One writer for page hits, and it is `flushPageHits`. This call used to
    // hold a second copy of the same insert loop; with the loop flushing every
    // tick that copy would find nothing to do on almost every call, which is
    // the worst kind of dead code - it still looks like the thing doing the
    // work. Called rather than deleted because this function is also the
    // shutdown save, where it is the last chance to write anything at all.
    await flushPageHits()

    // `temp*` are the in-progress aggregation buckets, and they were **not**
    // in this object while `setup.ts` read `data.temp1h` on boot and
    // `core.loadTemps` knew how to restore them. Every restart therefore threw
    // away up to 59 seconds of 1h aggregation, up to 29 minutes of 1d, and so
    // on - and because a bucket only finalises at its full count, the 1h chart
    // stayed empty for up to an hour after every boot rather than resuming.
    const coreData: any = {
      history1m: history1m as AnalyticsSnapshot[],
      history1h: history1h as AnalyticsSnapshot[],
      history1d: history1d as AnalyticsSnapshot[],
      history7d: history7d as AnalyticsSnapshot[],
      history30d: history30d as AnalyticsSnapshot[],
      pageHits: Array.from(pageHitsMap.entries()),
      ...snapshotTemps(),
    }
    try {
      stmtUpsertCore.run('core', JSON.stringify(coreData))
    } catch {
      // The snapshot is rebuilt from memory on the next flush, so a failed
      // upsert costs one interval of persisted history — not anything the
      // process still holds.
    }
  } catch (e) {
    // Telemetry must never be able to take down what it is measuring, so this
    // still does not rethrow — but it is no longer silent.
    //
    // The comment that used to sit here said the next flush retries. That is
    // false exactly where it mattered: the flush registered in `onShutdown` is
    // the last one there will ever be, so a throw there loses everything since
    // the previous save, and lost it without a line of output. That is how a
    // shared-cache-DB close ordered ahead of this hook stayed invisible.
    analyticsLog.SAVE_ERR({ error: errorMsg(e) })
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
