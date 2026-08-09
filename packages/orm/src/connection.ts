import { AsyncLocalStorage } from 'node:async_hooks'
import { Try } from '@bakery-framework/core/utils'
import { createDbAdapter, type SQLAdapter } from './adapters'

let dbCache: any = null
let dbPromise: Promise<any> | null = null
let testDb: any = null

/**
 * Test seam. Unit tests that only need a stub adapter should call this instead
 * of `mock.module('./connection', …)` — Bun's module mocks are process-global
 * and are never restored, so one mocking test file silently breaks every later
 * test that needs a real connection.
 */
export function __setTestDb(db: unknown): void {
  testDb = db
}

export function __resetTestDb(): void {
  testDb = null
}

export function initDB(): Promise<SQLAdapter> {
  if (dbPromise) return dbPromise

  dbPromise = (async () => {
    dbCache = await createDbAdapter()
    return dbCache
  })().catch(error => {
    // Don't cache the rejection: a transient failure at boot would otherwise
    // make every later initDB() return the same error for the process lifetime,
    // with no way to reconnect short of a restart.
    dbPromise = null
    throw error
  })

  return dbPromise
}

export async function closeDB(): Promise<void> {
  if (dbCache) {
    await Try.catch(() => dbCache.close())
    dbCache = null
    dbPromise = null
  }
}

function getConn() {
  if (testDb) return testDb
  if (!dbCache) {
    throw new Error("DB not initialized. Call 'await initDB()' first.")
  }
  return dbCache
}

export const connection: SQLAdapter = new Proxy({} as SQLAdapter, {
  // Resolve once per access: this is the hottest path in the ORM, and calling
  // getConn() for both the target and the receiver doubled the work.
  get(_, prop) {
    const conn = getConn()
    return Reflect.get(conn, prop, conn)
  },
})

export const txStorage = new AsyncLocalStorage<any>()

export function getActiveDb(): SQLAdapter {
  return txStorage.getStore() ?? connection
}
