import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { handleSchema, handleTableData } from './endpoints'
import { __resetTestAccess, __setTestAccess, DbExplorerHandler } from './setup'

/**
 * A database stand-in that records what it was asked and does none of it —
 * same factory pattern as the dashboard's fixture, reduced to the explorer's
 * surface. The list of recordable methods *is* the read-only claim: if an
 * endpoint ever reaches for something this stub does not have, the test
 * fails with a TypeError naming the new capability.
 */
function createStubDb() {
  const calls: string[] = []
  const db = {
    getSchema: async () => {
      calls.push('getSchema')
      return { parcels: { id: {}, courier: {} } }
    },
    getData: async (table: string, opts: Record<string, unknown>) => {
      calls.push(`getData:${table}:${opts.page}`)
      return { rows: [{ id: 1, courier: 'dhl' }], total: 1 }
    },
  }
  return { db, calls }
}

const { db: stubDb, calls } = createStubDb()

beforeAll(async () => {
  await initConfig()
  __setTestDb(stubDb as any)
})

afterAll(() => {
  __resetTestDb()
  __resetTestAccess()
})

const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init)

// The predicate itself — isLoopback, isAuthorized, defaultAuthorize — is
// core's now (`utils/http/authorize.ts`) and is tested there, against the
// mode flags directly. The four cases that used to sit here were assertions
// about that shared guard, not about the explorer; duplicating them in each
// of the three plugins that consume it is how the copies drifted in the first
// place. What remains below is the explorer's own wiring: which paths it
// claims, which door admits, and what an unauthorised answer looks like.

describe('routing and the auth split', () => {
  test('canHandle claims exactly the two namespaces', () => {
    expect(DbExplorerHandler.canHandle('/_db')).toBe(true)
    expect(DbExplorerHandler.canHandle('/_db/app.js')).toBe(true)
    expect(DbExplorerHandler.canHandle('/api/_db/schema')).toBe(true)
    expect(DbExplorerHandler.canHandle('/_dbx')).toBe(false)
    expect(DbExplorerHandler.canHandle('/api/_dbx')).toBe(false)
    expect(DbExplorerHandler.canHandle('/db')).toBe(false)
  })

  test('unauthorised page requests 404, api requests 401', async () => {
    __setTestAccess({})

    const page = (await DbExplorerHandler.handle(
      '/_db',
      req('/_db'),
    )) as Response
    expect(page.status).toBe(404)

    const api = (await DbExplorerHandler.handle(
      '/api/_db/schema',
      req('/api/_db/schema'),
    )) as Response
    expect(api.status).toBe(401)
    expect(calls).not.toContain('getSchema')
  })

  test('authorised requests reach the endpoints', async () => {
    __setTestAccess({ authorize: () => 'read' })

    const schema = (await DbExplorerHandler.handle(
      '/api/_db/schema',
      req('/api/_db/schema'),
    )) as any
    expect(schema.status).toBe(200)
    expect(calls).toContain('getSchema')

    const rows = (await DbExplorerHandler.handle(
      '/api/_db/table-data?tableName=parcels&page=2',
      req('/api/_db/table-data?tableName=parcels&page=2'),
    )) as any
    expect(rows.status).toBe(200)
    expect(calls).toContain('getData:parcels:2')
  })

  test('an unknown path under the namespace is 404, authorised or not', async () => {
    __setTestAccess({ authorize: () => 'read' })
    const res = (await DbExplorerHandler.handle(
      '/api/_db/execute-action',
      req('/api/_db/execute-action', { method: 'POST' }),
    )) as Response
    expect(res.status).toBe(404)
  })
})

describe('read-only is structural', () => {
  test('the write endpoints the dashboard has simply do not exist here', async () => {
    __setTestAccess({ authorize: () => 'read' })

    // The dashboard's write surface, requested from the explorer: every one
    // must be a 404 — not a 403 behind a flag, a route that is not there.
    for (const path of [
      '/api/_db/query',
      '/api/_db/execute-action',
      '/api/_db/sessions/delete',
    ]) {
      const res = (await DbExplorerHandler.handle(
        path,
        req(path, { method: 'POST', body: '{}' }),
      )) as Response
      expect(`${path}:${res.status}`).toBe(`${path}:404`)
    }

    // And nothing above ever touched the database.
    expect(calls.filter(c => !c.startsWith('get'))).toEqual([])
  })

  test('endpoints reject a bad table name before the database hears of it', async () => {
    const before = calls.length
    const res = await handleTableData(
      new URL('http://localhost/api/_db/table-data?tableName=parcels;drop'),
    )
    expect((res as any).status).toBe(400)
    expect(calls.length).toBe(before)
  })

  test('handleSchema answers through the envelope', async () => {
    const res = (await handleSchema()) as any
    expect(res.status).toBe(200)
    expect(res.data.parcels).toBeDefined()
  })
})

/**
 * Which door admits, and what a level means once inside. The doors themselves —
 * constant-time comparison, the three credential spellings, `true` being a
 * denial, higher-wins — are `access.test.ts`'s subject and are not repeated
 * here; copying a shared guard's assertions into every consumer is how the
 * three plugin copies drifted in the first place.
 */
describe('access reaches the handler', () => {
  afterAll(() => {
    __resetTestAccess()
  })

  test('a users key admits where the predicate refuses', async () => {
    __setTestAccess({
      users: { ops: { credential: 'warehouse-key-9', access: 'read' } },
      authorize: () => false,
    })

    const denied = (await DbExplorerHandler.handle(
      '/api/_db/schema',
      req('/api/_db/schema'),
    )) as Response
    expect(denied.status).toBe(401)

    const admitted = (await DbExplorerHandler.handle(
      '/api/_db/schema',
      req('/api/_db/schema', { headers: { 'x-db-key': 'warehouse-key-9' } }),
    )) as any
    expect(admitted.status).toBe(200)
  })

  test('assets are served without a credential, so a denial is not unstyled', async () => {
    __setTestAccess({})
    const res = (await DbExplorerHandler.handle(
      '/_db/app.js',
      req('/_db/app.js'),
    )) as Response
    // Bundling may fail in a bare test process; what matters is that the guard
    // did not turn it into a 404 the way it does for `/_db`.
    expect(res.status).not.toBe(404)
    expect(res.status).not.toBe(401)
  })
})
