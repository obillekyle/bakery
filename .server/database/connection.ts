import { AsyncLocalStorage } from 'node:async_hooks'
import { Try } from '@server/utils'
import { createDbAdapter, type SQLAdapter } from './adapters'

let dbCache: any = null
let dbPromise: Promise<any> | null = null

export function initDB(): Promise<SQLAdapter> {
  if (dbPromise) return dbPromise

  dbPromise = (async () => {
    dbCache = await createDbAdapter()
    return dbCache
  })()

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
  if (!dbCache) {
    throw new Error("DB not initialized. Call 'await initDB()' first.")
  }
  return dbCache
}

export const connection: SQLAdapter = new Proxy({} as SQLAdapter, {
  get(_, prop) {
    return Reflect.get(getConn(), prop, getConn())
  },
})

export const txStorage = new AsyncLocalStorage<any>()

export function getActiveDb() {
  return txStorage.getStore() ?? connection
}
