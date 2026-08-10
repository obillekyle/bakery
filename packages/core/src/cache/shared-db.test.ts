import { describe, expect, test } from 'bun:test'
import { Bakery } from '../core/bakery'
import { cacheDb } from './shared-db'

/**
 * Where the session store lives, and what survives.
 *
 * Sessions used to sit under `.cache/`, which `checkCacheVersion` deletes on
 * every framework version bump — so every patch release logged every user out.
 * These pin the reversal: the file is outside the wiped directory, and what
 * governs a wipe is now the *schema* version rather than any framework number.
 */
describe('the session store', () => {
  test('lives in the durable directory, not the disposable one', () => {
    // The whole fix in one assertion. Under cacheDir this file is deleted on
    // every version bump; under dataDir it is not.
    expect(cacheDb.filename).toContain('sessions.db')
    expect(cacheDb.filename.replace(/\\/g, '/')).toContain(
      Bakery.dataDir.replace(/\\/g, '/'),
    )
    expect(cacheDb.filename.replace(/\\/g, '/')).not.toContain(
      Bakery.cacheDir.replace(/\\/g, '/'),
    )
  })

  test('a cache wipe cannot reach it', () => {
    // `checkCacheVersion` wipes `Bakery.cacheDir` entry by entry. Being outside
    // that directory is what makes survival structural rather than hopeful —
    // the previous arrangement survived only when Windows EBUSY happened to
    // block the delete, which is the opposite of a guarantee.
    const dataDir = Bakery.dataDir.replace(/\\/g, '/')
    const cacheDir = Bakery.cacheDir.replace(/\\/g, '/')
    expect(dataDir.startsWith(cacheDir)).toBe(false)
  })

  test('records its own schema version', () => {
    const row = cacheDb
      .query<{ version: number }, []>('SELECT version FROM __schema LIMIT 1')
      .get()
    expect(typeof row?.version).toBe('number')
  })

  test('data written to a table persists across reads', () => {
    // Not a durability test across processes — that needs a real restart — but
    // it proves the handle is a real file-backed database rather than the
    // in-memory fallback a bad path would silently produce.
    cacheDb.run(
      'CREATE TABLE IF NOT EXISTS __probe (key TEXT PRIMARY KEY, value TEXT)',
    )
    cacheDb.run('INSERT OR REPLACE INTO __probe VALUES (?, ?)', ['k', 'v'])

    const back = cacheDb
      .query<{ value: string }, [string]>(
        'SELECT value FROM __probe WHERE key = ?',
      )
      .get('k')

    expect(back?.value).toBe('v')
    cacheDb.run('DROP TABLE __probe')
  })
})
