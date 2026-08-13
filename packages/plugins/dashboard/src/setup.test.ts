import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { JsonResponseData } from '@bakery-framework/core/utils/common'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
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
      new Request(
        `http://localhost/api/_dashboard/table-data?tableName=${TABLE}`,
      ),
    )

    // getData is absent from the stub, so this fails inside the endpoint — the
    // point is that it was dispatched at all rather than refused by a guard.
    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).not.toBe(403)
  })
})

/**
 * The predicate's own semantics — loopback matching, throwing predicates,
 * truthy-non-boolean denial, the production default — live in
 * `packages/core/src/utils/http/authorize.test.ts` now that the guard is
 * core's. What is dashboard's and stays here is the *wiring*: that the console
 * consults the predicate at all, and that a denial is shaped differently for an
 * API path than for a page.
 */
describe('dashboard authorization wiring', () => {
  const denyAll = () => false

  afterAll(() => {
    // Back to the file-wide allow set in the outer `beforeAll`, so ordering
    // between describes cannot decide whether the CSRF cases above are reached.
    __setTestAuthorize(() => true)
  })

  test('an unauthorized API request is refused with 401', async () => {
    __setTestAuthorize(denyAll)

    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema'),
    )

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(401)
    expect(dbCalls).toEqual([])
  })

  test('an unauthorized page request is refused with 404, not 401', async () => {
    // A 401 on the shell would confirm the console is mounted at this path to
    // anyone who probes for it; the page half answers as if nothing is there.
    __setTestAuthorize(denyAll)

    const res = await handleDashboardRequest(
      new Request('http://localhost/_dashboard'),
    )

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })

  test('the denial happens before CSRF, so a probe learns nothing', async () => {
    // Auth runs first deliberately: a cross-origin POST from an unauthenticated
    // peer must get the same 401 as any other unauthenticated request, not the
    // 403 that would tell it the endpoint exists.
    __setTestAuthorize(denyAll)

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

    expect((res as Response).status).toBe(401)
    expect(dbCalls).toEqual([])
  })

  test('assets are served without consulting the predicate', async () => {
    // Styling and script are not secrets, and letting them through keeps an
    // unauthorised response from rendering unstyled.
    __setTestAuthorize(() => {
      throw new Error('the predicate must not be consulted for assets')
    })

    expect(
      await handleDashboardRequest(
        new Request('http://localhost/_dashboard/style.css'),
      ),
    ).toBeNull()
  })

  test('a granting predicate lets the same API request through', async () => {
    // The other direction: the guard must not have made the console useless.
    __setTestAuthorize(() => true)

    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema'),
    )

    expect(res).not.toBeInstanceOf(Response)
  })

  // Not covered here: that `setupDashboard` hands its `authorize` option to
  // `resolveAuthorize` rather than dropping it. Reaching it means calling
  // `setupDashboard`, which also mounts routes, registers the handler at
  // priority 120 and installs a global log callback — three process-global
  // mutations with no restore, which is the leak convention 9 exists to stop
  // and the reason the `beforeAll` above uses the `__setTestAuthorize` seam
  // instead. The line is one `resolveAuthorize` call; the seam covers
  // everything downstream of it.
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
    expect(
      DashboardHandler.resolveRoute('/_dashboard/style.css'),
    ).not.toBeNull()
  })

  test('a look-alike path is not handled by the request pipeline', async () => {
    expect(
      await handleDashboardRequest(
        new Request('http://localhost/api/_dashboard-anything'),
      ),
    ).toBeNull()
  })
})
