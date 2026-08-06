import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __resetTestConfig, initConfig } from './core/config'
import { deferredValue } from './utils/common'
import { DEFAULT_SESSION_TTL } from './utils/constants'
import { db } from './cache/tiered'
import {
  __resetTestClock,
  __setTestClock,
  newSessionId,
  Session,
} from './session'

/**
 * The accessed/modified split. `Session.from` used to `touch()` every session
 * it returned, which marked merely-read sessions dirty — so read-only traffic
 * paid a JSON.stringify + SQLite write on every flush and got a fresh
 * Set-Cookie on every response, defeating If-None-Match for any page that
 * carries a session. Reading is now an *accessed* bump (memory-tier liveness
 * only); *modified* keeps exactly the old behavior; the cookie slides via a
 * half-life reissue instead of a per-request one.
 */
describe('session accessed/modified split', () => {
  beforeAll(async () => {
    await initConfig()
  })

  afterAll(() => {
    __resetTestClock()
    __resetTestConfig()
  })

  /** Wire `req.session` the way `worker.ts` does. */
  function makeReq(sessionId?: string): Request {
    const req = new Request(
      'http://localhost/',
      sessionId ? { headers: { cookie: `sId=${sessionId}` } } : undefined,
    )
    deferredValue(req, 'session', Session.from)
    return req
  }

  /** Create a session through the request path and issue its first cookie. */
  function login(): { id: string; cookie: string } {
    const req = makeReq()
    req.session.set('user', 'kyle')
    const cookie = Session.getCookie(req)
    return { id: req.session.id, cookie }
  }

  function sessionRow(id: string) {
    return db
      .prepare('SELECT value, accessedAt FROM sessions WHERE key = ?')
      .get(id) as { value: string; accessedAt: number } | null
  }

  test('a new session issues its cookie exactly once', () => {
    const { id, cookie } = login()
    expect(cookie).toContain(`sId=${id}`)

    // The very next read-only request must not re-issue.
    const read = makeReq(id)
    expect(read.session.get('user')).toBe('kyle')
    expect(Session.getCookie(read)).toBe('')
  })

  test('a brand-new session that is never written gets no cookie', () => {
    const req = makeReq()
    expect(req.session.get('anything')).toBeUndefined()
    expect(Session.getCookie(req)).toBe('')
  })

  test('a read-only request marks nothing dirty and writes nothing on flush', () => {
    const { id } = login()

    // Settle the write from login, then snapshot the persisted row.
    Session.cache.flushToDisk()
    expect(Session.cache.isDirty).toBe(false)
    const before = sessionRow(id)
    expect(before).not.toBeNull()

    for (let i = 0; i < 3; i++) {
      const read = makeReq(id)
      expect(read.session.get('user')).toBe('kyle')
      expect(Session.getCookie(read)).toBe('')
    }

    // No dirty key was queued, so the flush is a no-op and the row unchanged.
    expect(Session.cache.isDirty).toBe(false)
    Session.cache.flushToDisk()
    expect(sessionRow(id)).toEqual(before!)
  })

  test('set() still dirties, persists and re-issues the cookie', () => {
    const { id } = login()
    Session.cache.flushToDisk()
    const before = sessionRow(id)

    const req = makeReq(id)
    req.session.set('cart', 3)
    expect(req.session.isModified).toBe(true)
    expect(Session.getCookie(req)).toContain(`sId=${id}`)

    expect(Session.cache.isDirty).toBe(true)
    Session.cache.flushToDisk()
    const after = sessionRow(id)
    expect(after).not.toEqual(before!)
    expect(JSON.parse(after!.value).data.cart).toBe(3)
  })

  test('a write through the data proxy counts as modified', () => {
    const { id } = login()
    Session.cache.flushToDisk()

    const req = makeReq(id)
    ;(req.session.data as any).theme = 'dark'
    expect(req.session.isModified).toBe(true)
    expect(Session.getCookie(req)).toContain(`sId=${id}`)
    expect(Session.cache.isDirty).toBe(true)
  })

  test('the half-life reissue fires once elapsed exceeds maxAge / 2', () => {
    let now = 1_750_000_000_000
    __setTestClock(() => now)

    const { id } = login() // cookie stamped at `now`
    Session.cache.flushToDisk()

    // Just under half the Max-Age: still no reissue.
    now += DEFAULT_SESSION_TTL / 2 - 1000
    const early = makeReq(id)
    expect(early.session.get('user')).toBe('kyle')
    expect(Session.getCookie(early)).toBe('')
    expect(Session.cache.isDirty).toBe(false)

    // Past half: the cookie comes back, and the session re-persists so the
    // DB row's accessedAt slides with it (server-side TTL keeps pace).
    now += 2000
    const late = makeReq(id)
    expect(late.session.get('user')).toBe('kyle')
    expect(Session.getCookie(late)).toContain(`sId=${id}`)
    expect(Session.cache.isDirty).toBe(true)

    // The reissue restamped cookieIssuedAt: the next read is quiet again.
    const settled = makeReq(id)
    expect(settled.session.get('user')).toBe('kyle')
    expect(Session.getCookie(settled)).toBe('')

    __resetTestClock()
  })

  test('a revived session without cookieIssuedAt fails toward one reissue', () => {
    // Simulate a row written before the field existed: reconstruct without it.
    const id = newSessionId()
    Session.create({ id, persistKeys: [], data: { user: 'legacy' } })

    const req = makeReq(id)
    expect(req.session.get('user')).toBe('legacy')
    // Unknown issuance time reads as "long past half-life": reissue once…
    expect(Session.getCookie(req)).toContain(`sId=${id}`)
    // …then the stamp exists and the next read is quiet.
    const next = makeReq(id)
    expect(next.session.get('user')).toBe('legacy')
    expect(Session.getCookie(next)).toBe('')
  })
})
