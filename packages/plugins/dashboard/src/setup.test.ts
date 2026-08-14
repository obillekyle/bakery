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
  setAnalyticsAuthorize,
  setAnalyticsCredential,
} from '@bakery-framework/plugin-analytics/stats'
import { DashboardHandler, handleDashboardRequest } from './setup'
import { createStubDb } from './test-fixtures'

/**
 * The console has no predicate of its own to seam: `setAnalyticsAuthorize` and
 * `setAnalyticsCredential` are the state `checkAuthMiddleware` reads, which is
 * the point of the delegation and is why these tests reach for analytics'
 * setters rather than a dashboard-local one. They are module-level process
 * state, so anything set here is cleared in `afterAll` — an armed door left
 * behind is inherited by every file Bun loads after this one.
 */
function openTheDoor() {
  setAnalyticsAuthorize(() => true)
}

function closeTheDoor() {
  setAnalyticsAuthorize(undefined)
  setAnalyticsCredential(undefined)
}

/**
 * The console's mutating surface is now the two session routes and nothing
 * else. These cases used to drive `POST /api/_dashboard/execute-action`,
 * whose `truncate` emptied a table — the worst thing a CSRF hole here could
 * reach. That endpoint retired with the grid editor
 * (`@bakery-framework/plugin-db-explorer` owns row editing now), so the same
 * two guards are exercised against what is left. The blast radius shrank; the
 * guards did not, and a regression in either is still a session takeover.
 */
const DELETE_URL = 'http://localhost/api/_dashboard/sessions/delete'
// A session id that does not exist, so a case that wrongly reaches the
// endpoint destroys nothing while still proving it was dispatched.
const VICTIM = 'nonexistent_session_csrf_probe'
const TABLE = 'nonexistent_table_csrf_probe'

/**
 * Records what the endpoint asked the database to do. The read endpoints below
 * go through it; the assertion that matters is that it stays empty on every
 * refused request.
 */
const { db: stubDb, calls: dbCalls, reset: resetDbCalls } = createStubDb()

beforeAll(() => {
  // The predicate, not `setupDashboard`: that also mounts routes, registers the
  // handler at priority 120 and installs a global log callback, none of which
  // can be undone afterwards.
  openTheDoor()
  __setTestDb(stubDb)
})

afterAll(() => {
  closeTheDoor()
  __resetTestDb()
})

beforeEach(() => {
  resetDbCalls()
})

function deleteBody() {
  return JSON.stringify({ id: VICTIM })
}

describe('dashboard CSRF and method qualification', () => {
  test('a cross-origin GET cannot reach sessions/delete', async () => {
    // GET is in `SAFE_METHODS`, so `checkCsrf` returns null for this by design;
    // `processBody` then reads the query string as the body. Method-qualifying
    // the route key is the only thing that stops it — this is the half the
    // CSRF guard structurally cannot cover.
    const res = await handleDashboardRequest(
      new Request(`${DELETE_URL}?id=${VICTIM}`, {
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      }),
    )

    expect(res).toBeNull()
  })

  test('a same-origin GET cannot reach sessions/delete either', async () => {
    const res = await handleDashboardRequest(
      new Request(`${DELETE_URL}?id=${VICTIM}`),
    )

    expect(res).toBeNull()
  })

  test('a cross-origin POST is rejected before dispatch', async () => {
    // And this is the half method-qualification cannot cover: a cross-origin
    // <form method=post> is a CORS-simple request and arrives with the
    // operator's cookies attached.
    const res = await handleDashboardRequest(
      new Request(DELETE_URL, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: deleteBody(),
      }),
    )

    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).toBe(403)
    expect((res as JsonResponseData).message).toContain('cross-origin')
  })

  test('a cross-site POST is rejected on Sec-Fetch-Site alone', async () => {
    const res = await handleDashboardRequest(
      new Request(DELETE_URL, {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'cross-site',
          'content-type': 'application/json',
        },
        body: deleteBody(),
      }),
    )

    expect((res as JsonResponseData).status).toBe(403)
    expect((res as JsonResponseData).message).toContain('cross-site')
  })

  test('a GET cannot reach any mutating route', async () => {
    // An unqualified route key matches any method, and `processBody` hands a
    // GET its query string as the body. A link was enough to delete a session
    // or to set a key on someone else's.
    const paths = [
      '/api/_dashboard/sessions/delete?id=victim',
      '/api/_dashboard/sessions/update?id=victim&key=role&value=admin',
    ]

    for (const path of paths) {
      expect(
        await handleDashboardRequest(new Request(`http://localhost${path}`)),
      ).toBeNull()
    }
  })

  test('the retired write endpoints are not routes any more', async () => {
    // Not merely gated — absent. `DASHBOARD_ALLOW_WRITES` is gone with them,
    // so there is no flag that brings them back, and a stale client or a
    // bookmarked probe finds nothing to dispatch to.
    for (const path of [
      '/api/_dashboard/query',
      '/api/_dashboard/execute-action',
    ]) {
      const post = await handleDashboardRequest(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: {
            origin: 'http://localhost',
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sql: `DELETE FROM ${TABLE}`,
            action: 'truncate',
            tableName: TABLE,
          }),
        }),
      )

      expect(post).toBeNull()
    }

    expect(dbCalls).toEqual([])
  })

  test('a same-origin POST still reaches the endpoint', async () => {
    // The other direction: the guards must not have made the console useless.
    // The session does not exist, so the endpoint answers 404 — which is the
    // proof it was dispatched rather than refused by a guard at 403.
    const res = await handleDashboardRequest(
      new Request(DELETE_URL, {
        method: 'POST',
        headers: {
          origin: 'http://localhost',
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
        },
        body: deleteBody(),
      }),
    )

    expect(res).toBeInstanceOf(JsonResponseData)
    expect((res as JsonResponseData).status).toBe(404)
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
    openTheDoor()
  })

  test('an unauthorized API request is refused with 401', async () => {
    setAnalyticsAuthorize(denyAll)

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
    setAnalyticsAuthorize(denyAll)

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
    setAnalyticsAuthorize(denyAll)

    const res = await handleDashboardRequest(
      new Request(DELETE_URL, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
        },
        body: deleteBody(),
      }),
    )

    expect((res as Response).status).toBe(401)
    expect(dbCalls).toEqual([])
  })

  test('assets are served without consulting the predicate', async () => {
    // Styling and script are not secrets, and letting them through keeps an
    // unauthorised response from rendering unstyled.
    setAnalyticsAuthorize(() => {
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
    openTheDoor()

    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema'),
    )

    expect(res).not.toBeInstanceOf(Response)
  })

  // Not covered here: that `setupDashboard` hands its options to
  // `setupAnalytics` rather than dropping them. Reaching it means calling
  // `setupDashboard`, which also mounts routes, registers the handler at
  // priority 120 and installs a global log callback — three process-global
  // mutations with no restore, which is the leak convention 9 exists to stop.
  // What the block below covers instead is the half that matters at request
  // time: that the state those options land in is the state the console reads.
})

/**
 * The delegation itself. `@bakery-framework/plugin-analytics` is a hard
 * dependency of this package and owns the door for both surfaces, so what is
 * asserted here is that the console has no second door of its own: setting
 * analytics' credential, and nothing else, admits a *dashboard* request.
 *
 * Verified by planting the pre-delegation guard back — a module-local
 * predicate defaulting to `defaultAuthorize`, checked with `isAuthorized` —
 * and re-running: the three *admission* cases fail against it, because a
 * console with its own door never looks at analytics' credential or
 * predicate and refuses all three.
 *
 * The two refusal cases pass against the plant as well, and are kept as
 * controls rather than as evidence. A wrong key is refused by any guard, and
 * "neither configured" is refused by the old one too — `bun test` runs with
 * `PROD` set, so `defaultAuthorize` denies before `isLoopback` is reached, and
 * `isLoopback` would deny anyway with no server to read a peer address from.
 * They pin the shape of the denial; the three above pin the delegation.
 */
describe('the console delegates its door to analytics', () => {
  afterAll(() => {
    // Same reason as the block above: back to the file-wide allow, and the
    // outer `afterAll` clears both halves before the next file loads.
    closeTheDoor()
    openTheDoor()
  })

  test('the analytics credential admits a dashboard request', async () => {
    closeTheDoor()
    setAnalyticsCredential('ops-key-7')

    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema', {
        headers: { 'x-analytics-key': 'ops-key-7' },
      }),
    )

    // Not a `Response`: the guard returns one only to refuse. Reaching the
    // endpoint means the envelope comes back instead.
    expect(res).not.toBeInstanceOf(Response)
  })

  test('the analytics credential admits the console page too', async () => {
    // The page half takes the 404 branch when refused, so a bare status check
    // on `/api/` alone would not tell the two apart.
    closeTheDoor()
    setAnalyticsCredential('ops-key-7')

    const res = await handleDashboardRequest(
      new Request('http://localhost/_dashboard?analytics-key=ops-key-7'),
    )

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(200)
  })

  test('a wrong analytics credential is refused', async () => {
    closeTheDoor()
    setAnalyticsCredential('ops-key-7')

    const res = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema', {
        headers: { 'x-analytics-key': 'wrong' },
      }),
    )

    expect((res as Response).status).toBe(401)
    expect(dbCalls).toEqual([])
  })

  test('an analytics authorize predicate admits a dashboard request', async () => {
    closeTheDoor()
    setAnalyticsAuthorize(req => req.headers.get('x-role') === 'admin')

    const admitted = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema', {
        headers: { 'x-role': 'admin' },
      }),
    )
    expect(admitted).not.toBeInstanceOf(Response)

    const refused = await handleDashboardRequest(
      new Request('http://localhost/api/_dashboard/schema', {
        headers: { 'x-role': 'guest' },
      }),
    )
    expect((refused as Response).status).toBe(401)
  })

  test('neither configured denies, and the console has no default of its own', async () => {
    // The console's `defaultAuthorize` lives at the *setup* boundary now — it
    // is forwarded into analytics as an explicit predicate — so an analytics
    // door with nothing in it is closed even to loopback, which is exactly
    // what a request arriving here with no configuration must find.
    closeTheDoor()

    expect(
      (
        (await handleDashboardRequest(
          new Request('http://localhost/api/_dashboard/schema'),
        )) as Response
      ).status,
    ).toBe(401)

    expect(
      (
        (await handleDashboardRequest(
          new Request('http://localhost/_dashboard'),
        )) as Response
      ).status,
    ).toBe(404)

    expect(dbCalls).toEqual([])
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
    expect(DashboardHandler.canHandle('/api/_dashboard/schema')).toBe(true)
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
