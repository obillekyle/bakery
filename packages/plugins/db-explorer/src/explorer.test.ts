import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { handleSchema, handleTableData } from './endpoints/read'
import { __resetTestAccess, __setTestAccess, DbExplorerHandler } from './setup'

/**
 * A database stand-in that records what it was asked and does none of it —
 * same factory pattern as the dashboard's fixture, reduced to the explorer's
 * surface.
 *
 * **The list of recordable methods is still the contract; what it claims has
 * changed.** It used to enumerate *no* write capability at all, because there
 * was none. It now enumerates a **bounded** one: four introspection reads,
 * `getData`, `query` and a `transaction`. There is deliberately no `drop`, no
 * `truncate`, no `syncSchema`, no `remove`, and no `update(table, rowid, row)`
 * — an endpoint reaching for any of those fails here with a TypeError naming
 * the capability it wanted, which is the property this fixture is for.
 *
 * The write endpoints' own behaviour lives in `crud.test.ts`; this file is the
 * explorer's wiring — which paths it claims, which door admits, and what an
 * unauthorised answer looks like.
 */
function createStubDb() {
  const calls: string[] = []
  const seen: { filters?: unknown } = {}
  const db = {
    getSchema: async () => {
      calls.push('getSchema')
      return [
        {
          name: 'parcels',
          rowCount: 1,
          columns: [
            { name: 'id', type: 'INTEGER', notnull: true, pk: true },
            { name: 'courier', type: 'TEXT', notnull: true, pk: false },
            // Snake-cased on purpose: `getIndexes()` camel-cases its column
            // names and the report has to translate them back, so a column
            // whose two spellings differ is the only one that proves it.
            { name: 'picked_up', type: 'TEXT', notnull: false, pk: false },
          ],
          indexes: [],
        },
      ]
    },
    getConstraints: async () => {
      calls.push('getConstraints')
      return {
        parcels: {
          id: { type: 'integer', primary: true, nullable: false },
          courier: { type: 'string', nullable: false },
          pickedUp: { type: 'string', nullable: true },
        },
      }
    },
    getIndexes: async () => {
      calls.push('getIndexes')
      // Keyed by index name, `table` and `cols` camel-cased — the shape the
      // adapters actually report.
      return {
        ix_picked: {
          type: 'index',
          table: 'parcels',
          cols: ['pickedUp'],
          rawCols: ['picked_up'],
        },
      }
    },
    getForeignKeys: async () => {
      calls.push('getForeignKeys')
      return {}
    },
    getData: async (table: string, opts: Record<string, unknown>) => {
      calls.push(`getData:${table}:${opts.page}`)
      // Recorded rather than merely counted: the filter vocabulary is the one
      // thing this endpoint validates, and "did it reach the adapter, in what
      // shape" is the question the tests below ask.
      seen.filters = opts.filters
      return { rows: [{ id: 1, courier: 'dhl' }], totalRows: 1 }
    },
    query: (sql: string) => {
      calls.push(`query:${sql.trim().split(/\s+/)[0]}`)
      return {
        all: () => [],
        get: () => undefined,
        run: () => ({ changes: 0, lastInsertRowid: null }),
      }
    },
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      calls.push('transaction')
      return await callback(db)
    },
  }
  return { db, calls, seen }
}

const { db: stubDb, calls, seen } = createStubDb()

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
// place. What remains below is the explorer's own wiring.

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

  test('an unauthorised write is 401 before anything else is decided', async () => {
    __setTestAccess({})
    const res = (await DbExplorerHandler.handle(
      '/api/_db/rows',
      req('/api/_db/rows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"table":"parcels","rows":[{"courier":"dhl"}]}',
      }),
    )) as Response
    // 401, not 403: the handler's own guard runs before the endpoint's
    // `currentCanWrite()`, and an unadmitted caller has no access level at all.
    expect(res.status).toBe(401)
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

describe('no raw SQL and no DDL — structurally, not by configuration', () => {
  test('the write endpoints the dashboard used to have do not exist here', async () => {
    __setTestAccess({ authorize: () => 'write' })

    // The shapes these paths name are the ones this plugin refuses to have:
    // a raw-SQL prompt, a generic action dispatcher, and a write to another
    // plugin's namespace. Requested with the *highest* level this plugin
    // grants, every one must be a 404 — a route that is not there, rather than
    // a route refusing.
    //
    // The dashboard's own versions of the first two are now deleted rather
    // than gated, so this no longer contrasts two live designs. It still pins
    // the claim that matters: nothing here answers a statement someone sends.
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
  })

  test('the route table is exactly the eleven keys, six of them writes', async () => {
    // The bounded-write-surface claim, stated as the enumeration it is. The
    // assertion that used to sit here — "no non-`get*` DB call" — is false by
    // design now, so the boundary has to be drawn somewhere it is still true:
    // the set of routes, and the fact that nothing in it takes SQL or DDL.
    const { explorerRoutes } = await import('./setup')
    const keys = Object.keys(explorerRoutes).sort()
    expect(keys).toEqual(
      [
        '/_db',
        '/_db/app.js',
        '/api/_db/schema',
        '/api/_db/table-data',
        '/api/_db/graph',
        '/api/_db/lookup',
        'POST /api/_db/rows',
        'PATCH /api/_db/row',
        'POST /api/_db/rows/bulk',
        'DELETE /api/_db/rows',
        'POST /api/_db/import',
      ].sort(),
    )

    // Reads bare, writes method-qualified — `guardFor` in `plugins/routes.ts`
    // reads exactly this distinction, so it is policy rather than style.
    const qualified = keys.filter(k => k.includes(' '))
    expect(qualified.length).toBe(5)
    expect(keys.filter(k => !k.includes(' ')).length).toBe(6)
    for (const key of qualified) {
      expect(key).toMatch(/^(POST|PATCH|DELETE) /)
    }
  })

  test('endpoints reject a bad table name before the database hears of it', async () => {
    const before = calls.length
    const res = await handleTableData(
      new URL('http://localhost/api/_db/table-data?tableName=parcels;drop'),
    )
    expect((res as any).status).toBe(400)
    expect(calls.length).toBe(before)
  })

  test('handleSchema answers through the envelope, with the caller’s posture', async () => {
    const res = (await handleSchema()) as any
    expect(res.status).toBe(200)
    expect(res.data.tables[0].name).toBe('parcels')
    expect(res.data.tables[0].identity).toEqual({ mode: 'pk', cols: ['id'] })
    // Outside a request there is no access level, and the safe answer is none.
    expect(res.data.access).toBe(false)
    expect(res.data.tables[0].writable).toBe(false)
  })

  test('handleSchema reports the indexes it has always computed', async () => {
    // `introspect()` walks them to find a usable unique key when there is no
    // primary key, and used to throw them away. The Structure view is the
    // first thing that shows them and there is no other endpoint that knows
    // them, so their absence here is the feature missing.
    const res = (await handleSchema()) as any
    expect(res.data.tables[0].indexes).toEqual([
      // `pickedUp` in `cols`, `picked_up` in `rawCols`, and the raw spelling
      // is what reaches the screen: the grid speaks raw names, and the camel
      // one would name a column the table does not have. The adapter carries
      // both since the camel→raw rebuild was retired.
      { name: 'ix_picked', type: 'index', cols: ['picked_up'] },
    ])
    expect(res.data.tables[0].isView).toBe(false)
  })
})

/**
 * The filter vocabulary at the endpoint.
 *
 * The direction is the whole point: the ORM *drops* an operator it does not
 * know (`filterClause` in `orm/src/adapters/base.ts`), and a dropped filter
 * **widens** the result — on the very view the Delete button acts on. So the
 * endpoint refuses rather than forwards, and that refusal has to reach the
 * adapter as "no query at all" rather than "an unfiltered one".
 */
describe('table-data filters', () => {
  const url = (filters: string) =>
    new URL(
      `http://localhost/api/_db/table-data?tableName=parcels&filters=${encodeURIComponent(filters)}`,
    )

  test('an operator filter reaches the adapter in the object form', async () => {
    const res = (await handleTableData(
      url(JSON.stringify({ courier: { op: 'eq', value: 'dhl' } })),
    )) as any
    expect(res.status).toBe(200)
    expect(seen.filters).toEqual({ courier: { op: 'eq', value: 'dhl' } })
  })

  test('a nullary operator reaches it with no value to bind', async () => {
    await handleTableData(url(JSON.stringify({ courier: { op: 'null' } })))
    expect(seen.filters).toEqual({ courier: { op: 'null' } })
  })

  test('the bare scalar form still passes through unchanged', async () => {
    await handleTableData(url(JSON.stringify({ courier: 'dh' })))
    expect(seen.filters).toEqual({ courier: 'dh' })
  })

  test('an unknown operator is a 400 and never reaches the database', async () => {
    const before = calls.length
    const res = (await handleTableData(
      url(JSON.stringify({ courier: { op: 'regex', value: '.*' } })),
    )) as any
    expect(res.status).toBe(400)
    expect(res.message).toContain('regex')
    expect(calls.length).toBe(before)
  })

  test('a mangled filters parameter is a 400, not silently no filters', async () => {
    // Treating it as "no filters" would answer a question nobody asked, with
    // more rows than the caller believes they are looking at.
    const before = calls.length
    const res = (await handleTableData(url('{not json'))) as any
    expect(res.status).toBe(400)
    expect(calls.length).toBe(before)
  })

  test('no filters parameter is no filters, not an error', async () => {
    const res = (await handleTableData(
      new URL('http://localhost/api/_db/table-data?tableName=parcels'),
    )) as any
    expect(res.status).toBe(200)
    expect(seen.filters).toEqual({})
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
