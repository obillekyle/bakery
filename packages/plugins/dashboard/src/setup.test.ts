import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { JsonResponseData } from '@bakery/core/utils/common'
import { __resetTestDb, __setTestDb } from '@bakery/orm/connection'
import {
  __resetTestAuthorize,
  __setTestAuthorize,
  DashboardHandler,
  handleDashboardRequest,
} from './setup'
import { createStubDb } from './test-fixtures'

const ACTION_URL = 'http://localhost/api/_dashboard/execute-action'
// Nothing may be destroyed even when a case fails: this table does not exist,
// and the stub adapter below never reaches a real database anyway.
const TABLE = 'nonexistent_table_csrf_probe'

/**
 * Records what the endpoint asked the database to do. The assertion that
 * matters in every case below is that this stays empty — a rejection that
 * arrives *after* the truncate is not a rejection.
 */
const { db: stubDb, calls: dbCalls, reset: resetDbCalls } = createStubDb()

const priorAllowWrites = process.env.DASHBOARD_ALLOW_WRITES

beforeAll(() => {
  // The predicate, not `setupDashboard`: that also mounts routes, registers the
  // handler at priority 120 and installs a global log callback, none of which
  // can be undone afterwards.
  __setTestAuthorize(() => true)
  __setTestDb(stubDb)
  // Writes deliberately *enabled*. The subject here is the routing and CSRF
  // layer; leaving the write gate to reject everything would make these tests
  // pass for a reason that has nothing to do with what they claim to guard.
  process.env.DASHBOARD_ALLOW_WRITES = '1'
})

afterAll(() => {
  __resetTestAuthorize()
  __resetTestDb()
  if (priorAllowWrites === undefined) delete process.env.DASHBOARD_ALLOW_WRITES
  else process.env.DASHBOARD_ALLOW_WRITES = priorAllowWrites
})

beforeEach(() => {
  resetDbCalls()
})

function truncateBody() {
  return JSON.stringify({ action: 'truncate', tableName: TABLE })
}

describe('dashboard CSRF and method qualification', () => {
  test('a cross-origin GET cannot reach execute-action', async () => {
    // GET is in `SAFE_METHODS`, so `checkCsrf` returns null for this by design;
    // `processBody` then reads the query string as the body. Method-qualifying
    // the route key is the only thing that stops it — this is the half the
    // CSRF guard structurally cannot cover.
    const res = await handleDashboardRequest(
      new Request(`${ACTION_URL}?action=truncate&tableName=${TABLE}`, {
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      }),
    )

    expect(dbCalls).toEqual([])
    expect(res).toBeNull()
  })

  test('a same-origin GET cannot reach execute-action either', async () => {
    const res = await handleDashboardRequest(
      new Request(`${ACTION_URL}?action=truncate&tableName=${TABLE}`),
    )

    expect(dbCalls).toEqual([])
    expect(res).toBeNull()
  })

  test('a cross-origin POST is rejected before dispatch', async () => {
    // And this is the half method-qualification cannot cover: a cross-origin
    // <form method=post> is a CORS-simple request and arrives with the
    // operator's cookies attached.
    const res = await handleDashboardRequest(
      new Request(ACTION_URL, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: truncateBody(),
      }),
    )

    expect(dbCalls).toEqual([])
    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).toBe(403)
    expect((res as JsonResponseData).message).toContain('cross-origin')
  })

  test('a cross-site POST is rejected on Sec-Fetch-Site alone', async () => {
    const res = await handleDashboardRequest(
      new Request(ACTION_URL, {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: truncateBody(),
      }),
    )

    expect(dbCalls).toEqual([])
    expect((res as JsonResponseData).status).toBe(403)
    expect((res as JsonResponseData).message).toContain('cross-site')
  })

  test('a GET cannot reach any of the other mutating routes', async () => {
    // The same bare-key hole as execute-action, and it applies to every
    // mutating endpoint: an unqualified key matches any method, and
    // `processBody` hands a GET its query string as the body. A link was
    // enough to delete a session or to set a key on someone else's.
    const paths = [
      '/api/_dashboard/sessions/delete?id=victim',
      '/api/_dashboard/sessions/update?id=victim&key=role&value=admin',
      '/api/_dashboard/query?sql=SELECT%201',
    ]

    for (const path of paths) {
      expect(
        await handleDashboardRequest(new Request(`http://localhost${path}`)),
      ).toBeNull()
    }
  })

  test('a cross-origin POST to sessions/delete is rejected too', async () => {
    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/sessions/delete', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: 'anything' }),
      }),
    )

    expect((res as JsonResponseData).status).toBe(403)
  })

  test('a same-origin POST still reaches the endpoint', async () => {
    // The other direction: the guards must not have made the console useless.
    const res = await handleDashboardRequest(
      new Request(ACTION_URL, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: truncateBody(),
      }),
    )

    expect(dbCalls).toEqual([`truncate:${TABLE}`])
    expect((res as JsonResponseData).status).toBe(200)
  })

  test('a same-origin GET still reaches a read endpoint', async () => {
    const res = await handleDashboardRequest(
      new Request(`http://localhost/api/_dashboard/table-data?tableName=${TABLE}`),
    )

    // getData is absent from the stub, so this fails inside the endpoint — the
    // point is that it was dispatched at all rather than refused by a guard.
    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).not.toBe(403)
  })
})

describe('dashboard namespace boundary', () => {
  test('a look-alike path is not claimed at priority 120', () => {
    // Claiming it shadowed the application route that really owned it: this
    // handler outranks every content handler, so nothing below ever saw it.
    expect(DashboardHandler.canHandle('/api/_dashboard-anything')).toBe(false)
    expect(DashboardHandler.canHandle('/api/_dashboardxyz')).toBe(false)
    expect(DashboardHandler.canHandle('/api/_dashboard_backup')).toBe(false)
  })

  test('the namespace itself still resolves', () => {
    expect(DashboardHandler.canHandle('/api/_dashboard')).toBe(true)
    expect(DashboardHandler.canHandle('/api/_dashboard/query')).toBe(true)
    expect(DashboardHandler.canHandle('/_dashboard')).toBe(true)
    expect(DashboardHandler.canHandle('/_dashboard/dashboard.js')).toBe(true)
  })

  test('resolveRoute keeps the same boundary', () => {
    expect(DashboardHandler.resolveRoute('/_dashboard-admin')).toBeNull()
    expect(DashboardHandler.resolveRoute('/api/_dashboard-anything')).toBeNull()
    expect(DashboardHandler.resolveRoute('/_dashboard/style.css')).not.toBeNull()
  })

  test('a look-alike path is not handled by the request pipeline', async () => {
    expect(
      await handleDashboardRequest(
        new Request('http://localhost/api/_dashboard-anything'),
      ),
    ).toBeNull()
  })
})
