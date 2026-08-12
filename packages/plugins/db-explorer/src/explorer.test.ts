import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import {
  credentialMatches,
  defaultAuthorize,
  isAuthorized,
  isLoopback,
} from './authorize'
import { handleSchema, handleTableData } from './endpoints'
import {
  __resetTestAuthorize,
  __setTestAuthorize,
  __setTestCredential,
  DbExplorerHandler,
} from './setup'

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
  __resetTestAuthorize()
})

const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost${path}`, init)

describe('authorize', () => {
  test('an indeterminate address is a denial, not a fallback', () => {
    // No live server, no config host resolution: getClientIp throws or
    // returns nothing, and convention 2 says that means no.
    expect(isLoopback(req('/_db'))).toBe(false)
  })

  test('a throwing predicate is a denial', async () => {
    const denied = await isAuthorized(() => {
      throw new Error('identity service down')
    }, req('/_db'))
    expect(denied).toBe(false)
  })

  test('only a literal true admits', async () => {
    expect(await isAuthorized(() => 1 as any, req('/_db'))).toBe(false)
    expect(await isAuthorized(() => 'yes' as any, req('/_db'))).toBe(false)
    expect(await isAuthorized(() => true, req('/_db'))).toBe(true)
  })

  test('the default denies when the peer cannot be established', () => {
    expect(defaultAuthorize(req('/_db'))).toBe(false)
  })
})

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
    __setTestAuthorize(() => false)

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
    __setTestAuthorize(() => true)

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
    __setTestAuthorize(() => true)
    const res = (await DbExplorerHandler.handle(
      '/api/_db/execute-action',
      req('/api/_db/execute-action', { method: 'POST' }),
    )) as Response
    expect(res.status).toBe(404)
  })
})

describe('read-only is structural', () => {
  test('the write endpoints the dashboard has simply do not exist here', async () => {
    __setTestAuthorize(() => true)

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

describe('credential access', () => {
  afterAll(() => {
    __resetTestAuthorize()
  })

  test('unset or empty means off, never open', () => {
    expect(credentialMatches(undefined, req('/_db'))).toBe(false)
    expect(credentialMatches('', req('/_db'))).toBe(false)
    // Even a request *presenting* an empty key against an empty credential.
    expect(
      credentialMatches('', req('/_db', { headers: { 'x-db-key': '' } })),
    ).toBe(false)
  })

  test('header, bearer and query spellings all admit; wrong values do not', () => {
    const secret = 'warehouse-key-9'
    expect(
      credentialMatches(
        secret,
        req('/_db', { headers: { 'x-db-key': secret } }),
      ),
    ).toBe(true)
    expect(
      credentialMatches(
        secret,
        req('/_db', { headers: { authorization: `Bearer ${secret}` } }),
      ),
    ).toBe(true)
    expect(credentialMatches(secret, req(`/_db?db-key=${secret}`))).toBe(true)

    expect(
      credentialMatches(
        secret,
        req('/_db', { headers: { 'x-db-key': 'nope' } }),
      ),
    ).toBe(false)
    expect(credentialMatches(secret, req('/_db?db-key=warehouse-key-'))).toBe(
      false,
    )
  })

  test('the handler admits on credential even when the predicate denies', async () => {
    __setTestAuthorize(() => false)
    __setTestCredential('warehouse-key-9')

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
})
