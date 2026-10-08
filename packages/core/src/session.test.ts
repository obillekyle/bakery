import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery, hostStore } from './core/bakery'
import { __resetTestConfig, __setTestConfig, initConfig } from './core/config'
import { __resetTestClock, __setTestClock, Session } from './session'
import { signSessionId } from './session-signing'
import { deferredValue } from './utils/common'

describe('Session', () => {
  test('constructor creates session with random id', () => {
    const session = new Session()
    expect(session.id).toBeDefined()
    expect(session.id.length).toBeGreaterThan(0)
    expect(session.createdAt).toBeGreaterThan(0)
  })

  test('constructor accepts custom id', () => {
    const session = new Session('custom-id')
    expect(session.id).toBe('custom-id')
  })

  test('get/set on data', () => {
    const session = new Session('test')
    session.set('name', 'kyle')
    expect(session.get('name')).toBe('kyle')
  })

  test('get with default value', () => {
    const session = new Session('test')
    expect(session.get('missing', 'fallback')).toBe('fallback')
  })

  test('delete removes key', () => {
    const session = new Session('test')
    session.set('key', 'value')
    session.delete('key')
    expect(session.get('key')).toBeUndefined()
  })

  test('hasData returns true when data exists', () => {
    const session = new Session('test')
    expect(session.hasData()).toBe(false)
    session.set('a', 1)
    expect(session.hasData()).toBe(true)
  })

  test('isModified tracks changes', () => {
    const session = new Session('test')
    expect(session.isModified).toBe(false)
    session.set('a', 1)
    expect(session.isModified).toBe(true)
  })

  test('persist marks key as persisted', () => {
    const session = new Session('test')
    session.set('token', 'abc')
    session.persist('token')
    expect(session.hasPersistedKeys()).toBe(true)
    expect(session.persistedKeys).toContain('token')
  })

  test('persist(false) removes key from persisted set', () => {
    const session = new Session('test')
    session.persist('token', true)
    session.persist('token', false)
    expect(session.hasPersistedKeys()).toBe(false)
  })

  test('reset clears non-persisted data', () => {
    const session = new Session('test')
    session.set('temp', 1)
    session.set('permanent', 2)
    session.persist('permanent')
    session.reset()
    expect(session.get('temp')).toBeUndefined()
    expect(session.get('permanent')).toBe(2)
  })

  test('reset(true) clears everything', () => {
    const session = new Session('test')
    session.set('a', 1)
    session.persist('a')
    session.reset(true)
    expect(session.hasData()).toBe(false)
    expect(session.hasPersistedKeys()).toBe(false)
  })

  test('toJSON serializes correctly', () => {
    const session = new Session('test-id', 1000)
    session.set('key', 'val')
    const json = session.toJSON()
    expect(json.id).toBe('test-id')
    expect(json.createdAt).toBe(1000)
    expect(json.data.key).toBe('val')
  })

  test('destroy removes from cache', () => {
    const session = new Session('destroy-test')
    Session.cache.set('destroy-test', session)
    session.destroy()
    expect(Session.cache.get('destroy-test')).toBeUndefined()
  })

  test('Session.create adds to cache', () => {
    const session = Session.create({
      id: 'create-test',
      persistKeys: [],
      data: { x: 1 },
    })
    expect(Session.cache.get('create-test')).toBeDefined()
    expect(session.get('x')).toBe(1)
  })

  test('Session.reconstruct recreates session', () => {
    const session = Session.reconstruct({
      id: 'recon-test',
      createdAt: 500,
      persistKeys: ['token'],
      data: { token: 'abc' },
    })
    expect(session.id).toBe('recon-test')
    expect(session.createdAt).toBe(500)
    expect(session.get('token')).toBe('abc')
    expect(session.persistedKeys).toContain('token')
  })
})

/**
 * There is one `TieredCache('sessions')` for the process, and `Session.from`
 * looked its `sId` cookie up in it with no host check, so under a multi-tenant
 * `hosts` config a session id issued by one tenant was live on every other
 * tenant, and the dashboard's session list returned all of them regardless of
 * the originating host. `hostKey()` is the guard five other per-tenant caches
 * already apply.
 */
describe('sessions are scoped to the host that issued them', () => {
  const hosts = { 'a.com': {}, 'b.com': {} } satisfies Record<string, HostEntry>

  beforeAll(async () => {
    await initConfig()
  })

  afterAll(() => __resetTestConfig())

  function onHost<T>(hostname: string, fn: () => T): T {
    __setTestConfig({ hosts })
    return hostStore.run({ hostname, config: Bakery.config }, fn)
  }

  test('an id created on one host does not resolve on another', async () => {
    const id = 'cross-tenant-id'
    onHost('a.com', () =>
      Session.create({
        id,
        persistKeys: ['token'],
        data: { token: 'a-secret' },
      }),
    )

    expect(await onHost('a.com', () => Session.get(id))).toBeDefined()
    expect(await onHost('b.com', () => Session.get(id))).toBeUndefined()
  })

  test('a stolen cookie replayed against another host gets a fresh session', () => {
    const id = 'replayed-id'
    onHost('a.com', () =>
      Session.create({
        id,
        persistKeys: ['token'],
        data: { token: 'a-secret' },
      }),
    )

    const req = new Request('http://b.com/', {
      headers: { cookie: `sId=${signSessionId(id)}` },
    })
    const seen = onHost('b.com', () => Session.from(req))
    expect(seen.id).not.toBe(id)
    expect(seen.get('token')).toBeUndefined()

    // …and the real owner is untouched.
    const own = new Request('http://a.com/', {
      headers: { cookie: `sId=${signSessionId(id)}` },
    })
    expect(onHost('a.com', () => Session.from(own)).get('token')).toBe(
      'a-secret',
    )
  })

  test('delete on the wrong host is a no-op', async () => {
    const id = 'delete-scope-id'
    onHost('a.com', () =>
      Session.create({ id, persistKeys: ['keep'], data: { keep: 1 } }),
    )

    expect(onHost('b.com', () => Session.delete(id))).toBe(false)
    expect(await onHost('a.com', () => Session.get(id))).toBeDefined()
    expect(onHost('a.com', () => Session.delete(id))).toBe(true)
  })

  test('list, keys and values only see the current host', () => {
    onHost('a.com', () =>
      Session.create({ id: 'list-a', persistKeys: ['x'], data: { x: 1 } }),
    )
    onHost('b.com', () =>
      Session.create({ id: 'list-b', persistKeys: ['x'], data: { x: 1 } }),
    )

    const idsOnA = onHost('a.com', () => [...Session.keys()])
    expect(idsOnA).toContain('list-a')
    expect(idsOnA).not.toContain('list-b')

    const listed = onHost('a.com', () =>
      Session.list({ page: 1, pageSize: 100, sortBy: 'id', sortOrder: 'ASC' }),
    )
    const listedIds = listed.rows.map((s: Session<any>) => s.id)
    expect(listedIds).toContain('list-a')
    expect(listedIds).not.toContain('list-b')
    expect(listed.totalRows).toBe(listedIds.length)

    // Keys come back bare, so they round-trip through the id-taking statics.
    expect(
      onHost('b.com', () => [...Session.values()]).map(s => s.id),
    ).toContain('list-b')
  })
})

/**
 * `reset()` clears the data but keeps the id, and nothing else rotated it, so
 * an app that writes `userId` on login authenticates the id the visitor already
 * had, which is session fixation wherever an attacker can plant a cookie. The
 * cookie flags and the 32-byte CSPRNG id were already right; this was the
 * missing primitive.
 */
describe('Session.regenerate', () => {
  beforeAll(async () => {
    await initConfig()
  })

  test('mints a new id and carries the data across', () => {
    const session = Session.create({
      id: 'pre-auth-id',
      persistKeys: ['token'],
      data: { token: 'abc', cart: 2 },
    })

    session.regenerate()

    expect(session.id).not.toBe('pre-auth-id')
    expect(session.id.length).toBeGreaterThan(20)
    expect(session.get('token')).toBe('abc')
    expect(session.get('cart')).toBe(2)
    expect(session.persistedKeys).toContain('token')
  })

  test('the old id is dropped and the new one is live', async () => {
    const session = Session.create({
      id: 'rotate-me',
      persistKeys: ['token'],
      data: { token: 'abc' },
    })

    session.regenerate()

    expect(await Session.get('rotate-me')).toBeUndefined()
    expect(await Session.get(session.id)).toBeDefined()
  })

  test('a planted cookie stops working the moment the session rotates', () => {
    // The attacker fixes the id, then the victim logs in on it.
    const planted = 'attacker-chosen-id'
    const victim = new Request('http://localhost/', {
      headers: { cookie: `sId=${signSessionId(planted)}` },
    })
    Session.create({ id: planted, persistKeys: [], data: {} })

    const session = Session.from(victim)
    expect(session.id).toBe(planted)

    session.regenerate().set('userId', 'u_1024', true)

    // The attacker still holds `planted`; it now names nothing.
    const attacker = new Request('http://localhost/', {
      headers: { cookie: `sId=${signSessionId(planted)}` },
    })
    expect(Session.from(attacker).get('userId')).toBeUndefined()
  })

  test('the response re-issues the cookie with the new id', () => {
    const req = new Request('http://localhost/')
    deferredValue(req, 'session', () =>
      Session.create({ id: 'cookie-rotate', persistKeys: [], data: {} }),
    )
    // Read once so the deferred value is materialized, then rotate.
    const session = req.session as Session<any>
    session.regenerate()

    const cookie = Session.getCookie(req)
    expect(cookie).toContain(`sId=${session.id}`)
    expect(cookie).not.toContain('sId=cookie-rotate')
    expect(cookie).toContain('HttpOnly')
  })
})

/**
 * `destroy()` dropped the stored entry and left the object as it was: same id,
 * same data, and the flags that tell the response to store it. So the response
 * stored it again whenever it had a reason to, and both reasons are ordinary.
 * A cookie past half its Max-Age is due a refresh, which re-stores the session
 * (a persisted login older than 15 days, an ordinary one older than 30
 * minutes), and any write after the destroy marks it modified. Measured on
 * 2.1.2: the request after a logout still carried the account id in both cases.
 */
describe('Session.destroy', () => {
  beforeAll(async () => {
    await initConfig()
  })

  afterAll(() => {
    __resetTestClock()
  })

  function makeReq(id?: string): Request {
    const req = new Request(
      'http://localhost/',
      id ? { headers: { cookie: `sId=${signSessionId(id)}` } } : undefined,
    )
    deferredValue(req, 'session', Session.from)
    return req
  }

  function signIn(account: number): string {
    const req = makeReq()
    req.session.set('accountId', account, true)
    Session.getCookie(req)
    return req.session.id
  }

  test('a session past half its cookie lifetime stays destroyed', () => {
    const start = Date.now()
    __setTestClock(() => start)
    const id = signIn(7)

    // Sixteen days on: past half of a persisted cookie's thirty.
    __setTestClock(() => start + 16 * 24 * 60 * 60 * 1000)
    const logout = makeReq(id)
    logout.session.destroy()

    expect(Session.getCookie(logout)).toBe('')
    expect(makeReq(id).session.get('accountId')).toBeUndefined()
  })

  test('a write after destroy starts a new session instead of reviving the old one', () => {
    const id = signIn(8)

    const logout = makeReq(id)
    logout.session.destroy()
    logout.session.set('flash', 'Signed out')
    const cookie = Session.getCookie(logout)

    expect(logout.session.id).not.toBe(id)
    expect(cookie).toContain(`sId=${logout.session.id}`)
    expect(makeReq(id).session.get('accountId')).toBeUndefined()

    const next = makeReq(logout.session.id)
    expect(next.session.get('flash')).toBe('Signed out')
    expect(next.session.get('accountId')).toBeUndefined()
  })

  test('nothing is stored and no cookie is issued when nothing follows the destroy', () => {
    const id = signIn(9)
    const logout = makeReq(id)
    logout.session.destroy()

    expect(Session.getCookie(logout)).toBe('')
    expect(logout.session.hasData()).toBe(false)
    expect(logout.session.persistedKeys).toEqual([])
  })
})
