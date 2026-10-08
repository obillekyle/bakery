import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { Bakery, hostStore } from './core/bakery'
import { __resetTestConfig, __setTestConfig, initConfig } from './core/config'
import {
  __resetTestClock,
  __setTestClock,
  Session,
  type SessionListOptions,
  type SessionStore,
  type StoredSession,
} from './session'
import { signSessionId } from './session-signing'
import { DEFAULT_SESSION_PERSIST, DEFAULT_SESSION_TTL } from './utils/constants'

/**
 * Sessions with `sessions.store` set, against a store held in a Map.
 *
 * The store is the simplest one that keeps the contract, so what these pin is
 * the session layer: what it asks the store and when. The database store is
 * held to the same contract against real servers in
 * `@bakery-framework/orm`'s `sessions.test.ts`.
 */
class MapStore implements SessionStore {
  rows = new Map<string, StoredSession>()
  calls: string[] = []

  async load(host: string, id: string, now: number) {
    this.calls.push('load')
    const row = this.rows.get(id)
    return row && row.host === host && row.expiresAt > now
      ? structuredClone(row)
      : undefined
  }
  async insert(session: StoredSession) {
    this.calls.push('insert')
    if (this.rows.has(session.id)) throw new Error(`${session.id} is taken`)
    this.rows.set(session.id, structuredClone(session))
  }
  async update(storedId: string, session: StoredSession) {
    this.calls.push('update')
    const row = this.rows.get(storedId)
    if (!row || row.host !== session.host) return false
    this.rows.delete(storedId)
    this.rows.set(session.id, structuredClone(session))
    return true
  }
  async touch(host: string, id: string, accessedAt: number, expiresAt: number) {
    this.calls.push('touch')
    const row = this.rows.get(id)
    if (!row || row.host !== host) return false
    row.accessedAt = accessedAt
    row.expiresAt = expiresAt
    return true
  }
  async remove(host: string, id: string) {
    this.calls.push('remove')
    const row = this.rows.get(id)
    if (!row || row.host !== host) return false
    return this.rows.delete(id)
  }
  async removeAccount(host: string, account: string) {
    this.calls.push('removeAccount')
    let removed = 0
    for (const [id, row] of this.rows) {
      if (row.host === host && row.account === account) {
        this.rows.delete(id)
        removed++
      }
    }
    return removed
  }
  async count(now: number) {
    return [...this.rows.values()].filter(r => r.expiresAt > now).length
  }
  async list(host: string, options: SessionListOptions, now: number) {
    const live = [...this.rows.values()].filter(
      r => r.host === host && r.expiresAt > now,
    )
    const start = (options.page - 1) * options.pageSize
    return {
      rows: live.slice(start, start + options.pageSize),
      totalRows: live.length,
    }
  }
  async prune(now: number) {
    let pruned = 0
    for (const [id, row] of this.rows) {
      if (row.expiresAt <= now) {
        this.rows.delete(id)
        pruned++
      }
    }
    return pruned
  }
}

let store = new MapStore()

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetTestClock()
  __resetTestConfig()
})

afterAll(() => {
  __resetTestClock()
  __resetTestConfig()
})

/** A fresh store, configured, with `accountId` as the account key. */
function useStore(account: string | null = 'accountId'): MapStore {
  store = new MapStore()
  __setTestConfig({ sessions: { store, account: account ?? undefined } })
  return store
}

/** A request as `worker.ts` prepares one: the session attached and loaded. */
async function request(id?: string): Promise<Request> {
  const req = new Request(
    'http://localhost/',
    id ? { headers: { cookie: `sId=${signSessionId(id)}` } } : undefined,
  )
  const loading = Session.attach(req)
  if (loading) await loading
  return req
}

async function signIn(account: number | string): Promise<string> {
  const req = await request()
  req.session.set('accountId', account, true)
  await Session.commit(req)
  return req.session.id
}

describe('a configured session store', () => {
  test('a request without a session cookie never asks it', async () => {
    useStore()
    const req = await request()
    expect(req.session.get('accountId')).toBeUndefined()
    expect(await Session.commit(req)).toBe('')
    expect(store.calls).toEqual([])
  })

  test('a cookie that cannot be a session id costs no lookup', async () => {
    useStore()
    const req = new Request('http://localhost/', {
      headers: { cookie: 'sId=../../etc/passwd' },
    })
    expect(Session.attach(req)).toBeUndefined()
    expect(store.calls).toEqual([])
  })

  test('a made-up id costs no lookup, however well-formed', async () => {
    // Through 2.2.2 each of these was a lookup by primary key, made before the
    // rate limiter could refuse anything: a flood of them queued on the pool.
    useStore()
    const id = await signIn(7)
    store.calls = []
    const signed = signSessionId(id)
    const mac = signed.slice(signed.lastIndexOf('.') + 1)
    const forged = [
      id, // unsigned, as every cookie was before signing
      `${id}.${'A'.repeat(mac.length)}`, // a guessed MAC
      `${'B'.repeat(id.length)}.${mac}`, // another id under this one's MAC
      `${id}.${mac.slice(1)}`, // a MAC cut short
    ]
    for (const value of forged) {
      const req = new Request('http://localhost/', {
        headers: { cookie: `sId=${value}` },
      })
      expect(Session.attach(req)).toBeUndefined()
      expect(req.session.get('accountId')).toBeUndefined()
    }
    expect(store.calls).toEqual([])

    // The genuine cookie still costs exactly the one lookup.
    expect((await request(id)).session.get('accountId')).toBe(7)
    expect(store.calls).toEqual(['load'])
  })

  test('a session written by one request is the next request’s, read synchronously', async () => {
    useStore()
    const login = await request()
    login.session.regenerate().set('accountId', 7, true)
    const cookie = await Session.commit(login)
    expect(cookie).toContain(`sId=${login.session.id}`)
    expect(cookie).toContain(`Max-Age=${DEFAULT_SESSION_PERSIST / 1000}`)

    const row = store.rows.get(login.session.id)!
    expect(row.account).toBe('7')
    expect(row.persistKeys).toEqual(['accountId'])
    expect(row.expiresAt - row.accessedAt).toBe(DEFAULT_SESSION_PERSIST)

    const next = await request(login.session.id)
    expect(next.session.get('accountId')).toBe(7)
  })

  test('a request that only reads writes nothing and issues no cookie', async () => {
    useStore()
    const id = await signIn(7)
    store.calls = []

    const read = await request(id)
    expect(read.session.get('accountId')).toBe(7)
    expect(await Session.commit(read)).toBe('')
    expect(store.calls).toEqual(['load'])
  })

  test('past half its lifetime a session is renewed without being rewritten', async () => {
    const start = Date.now()
    __setTestClock(() => start)
    useStore()
    const id = await signIn(7)

    __setTestClock(() => start + DEFAULT_SESSION_PERSIST / 2 + 1000)
    const read = await request(id)
    expect(read.session.get('accountId')).toBe(7)
    // Another request writes the session while this one is in flight.
    store.rows.get(id)!.data.theme = 'dark'
    store.calls = []
    const cookie = await Session.commit(read)

    expect(cookie).toContain(`sId=${id}`)
    expect(store.calls).toEqual(['touch'])
    const row = store.rows.get(id)!
    expect(row.accessedAt).toBe(start + DEFAULT_SESSION_PERSIST / 2 + 1000)
    expect(row.data.theme).toBe('dark')
  })

  test('destroy removes the stored session at commit and stores nothing else', async () => {
    useStore()
    const id = await signIn(7)
    store.calls = []

    const logout = await request(id)
    logout.session.destroy()
    expect(await Session.commit(logout)).toBe('')
    expect(store.calls).toEqual(['load', 'remove'])
    expect(store.rows.has(id)).toBe(false)
  })

  test('a write after destroy is a session of its own', async () => {
    useStore()
    const id = await signIn(7)

    const logout = await request(id)
    logout.session.destroy()
    logout.session.set('flash', 'Signed out')
    const cookie = await Session.commit(logout)

    expect(store.rows.has(id)).toBe(false)
    expect(cookie).toContain(`sId=${logout.session.id}`)
    const fresh = store.rows.get(logout.session.id)!
    expect(fresh.data).toEqual({ flash: 'Signed out' })
    expect(fresh.account).toBeNull()
  })

  test('regenerate moves the stored row to the new id in one statement', async () => {
    useStore()
    const id = await signIn(7)
    store.calls = []

    const req = await request(id)
    req.session.regenerate()
    const cookie = await Session.commit(req)

    expect(store.calls).toEqual(['load', 'update'])
    expect(store.rows.has(id)).toBe(false)
    expect(store.rows.get(req.session.id)?.account).toBe('7')
    expect(cookie).toContain(`sId=${req.session.id}`)
  })

  test('reset then a write keeps the id: removed first, stored after', async () => {
    useStore()
    const req = await request()
    req.session.set('step', 1)
    await Session.commit(req)
    const id = req.session.id
    store.calls = []

    const next = await request(id)
    next.session.reset()
    next.session.set('step', 2)
    await Session.commit(next)

    expect(store.calls).toEqual(['load', 'remove', 'insert'])
    expect(store.rows.get(id)?.data).toEqual({ step: 2 })
  })

  test('a session ended after the request read it is not written back', async () => {
    useStore()
    const id = await signIn(7)

    const req = await request(id)
    // Ended in another worker while this request is in flight.
    store.rows.delete(id)
    req.session.set('lastPage', '/grades')
    expect(await Session.commit(req)).toBe('')
    expect(store.rows.has(id)).toBe(false)
  })

  test('nor is one due a cookie refresh', async () => {
    const start = Date.now()
    __setTestClock(() => start)
    useStore()
    const id = await signIn(7)

    __setTestClock(() => start + DEFAULT_SESSION_PERSIST / 2 + 1000)
    const req = await request(id)
    expect(req.session.get('accountId')).toBe(7)
    store.rows.delete(id)
    expect(await Session.commit(req)).toBe('')
    expect(store.rows.has(id)).toBe(false)
  })

  test('a stored session past its expiry is no session, whatever the store returns', async () => {
    useStore()
    const id = await signIn(7)
    const row = store.rows.get(id)!
    // A store that does not filter by `now` itself.
    store.load = async () => ({ ...structuredClone(row), expiresAt: 1 })
    expect((await request(id)).session.get('accountId')).toBeUndefined()
  })

  test('an ordinary session expires an hour after it was written', async () => {
    useStore()
    const req = await request()
    req.session.set('cart', 2)
    await Session.commit(req)
    const row = store.rows.get(req.session.id)!
    expect(row.expiresAt - row.accessedAt).toBe(DEFAULT_SESSION_TTL)
  })
})

describe('Session.endForAccount', () => {
  test('ends every session of the account on this host, and only those', async () => {
    useStore()
    const first = await signIn(7)
    const second = await signIn('7')
    const other = await signIn(8)
    __setTestConfig({
      sessions: { store, account: 'accountId' },
      hosts: { 'b.test': {} },
    })
    const elsewhere = await hostStore.run(
      { hostname: 'b.test', config: Bakery.config },
      () => signIn(7),
    )

    expect(await Session.endForAccount(7)).toBe(2)
    expect(store.rows.has(first)).toBe(false)
    expect(store.rows.has(second)).toBe(false)
    expect(store.rows.has(other)).toBe(true)
    expect(store.rows.has(elsewhere)).toBe(true)
    expect((await request(first)).session.get('accountId')).toBeUndefined()
  })

  test('refuses without sessions.account rather than ending nothing', async () => {
    useStore(null)
    await expect(Session.endForAccount(7)).rejects.toThrow(
      'Session.endForAccount needs sessions.account',
    )
  })

  test('the request that ends its own account writes nothing back', async () => {
    useStore()
    const id = await signIn(7)
    const req = await request(id)
    await Session.endForAccount(7)
    req.session.set('flash', 'Every session ended')
    expect(await Session.commit(req)).toBe('')
    expect(store.rows.size).toBe(0)
  })
})

describe('the statics with a configured store', () => {
  test('get reads a copy, and save writes an edit without moving its last access', async () => {
    useStore()
    const id = await signIn(7)
    const before = store.rows.get(id)!.accessedAt

    const session = (await Session.get(id))!
    expect(session.get('accountId')).toBe(7)
    session.set('role', 'registrar')
    expect(await Session.save(session)).toBe(true)

    const row = store.rows.get(id)!
    expect(row.data.role).toBe('registrar')
    expect(row.accessedAt).toBe(before)
  })

  test('save refuses a session ended meanwhile, and it stays ended', async () => {
    useStore()
    const id = await signIn(7)
    const session = (await Session.get(id))!
    store.rows.delete(id)
    session.set('role', 'registrar')
    expect(await Session.save(session)).toBe(false)
    expect(store.rows.has(id)).toBe(false)
  })

  test('end, total and page ask the store', async () => {
    useStore()
    const a = await signIn(7)
    await signIn(8)
    expect(await Session.total()).toBe(2)

    const page = await Session.page({
      page: 1,
      pageSize: 10,
      sortBy: 'accessed',
      sortOrder: 'DESC',
    })
    expect(page.totalRows).toBe(2)
    expect(page.rows.map(s => s.get('accountId')).sort()).toEqual([7, 8])

    expect(await Session.end(a)).toBe(true)
    expect(await Session.end(a)).toBe(false)
    expect(await Session.total()).toBe(1)
  })

  test('the synchronous statics refuse, naming what works instead', () => {
    useStore()
    const req = new Request('http://localhost/')
    expect(() => Session.count).toThrow('await Session.total()')
    expect(() => Session.delete('x')).toThrow('await Session.end(id)')
    expect(() => [...Session.keys()]).toThrow('await Session.page()')
    expect(() =>
      Session.list({ page: 1, pageSize: 1, sortBy: 'id', sortOrder: 'ASC' }),
    ).toThrow('await Session.page()')
    expect(() =>
      Session.create({ id: 'x', persistKeys: [], data: {} }),
    ).toThrow('req.session')
    expect(() => Session.getCookie(req)).toThrow('await Session.commit(req)')
    expect(() => Session.bind(req, new Response('ok'))).toThrow(
      'await Session.commit(req)',
    )
  })
})

/**
 * The built-in store keeps a session in memory, and every request that asks
 * gets the same object, so a session ended by an admin could be stored again
 * by a request already holding it.
 */
describe('ending sessions in the built-in store', () => {
  test('endForAccount ends what this process holds', async () => {
    __setTestConfig({ sessions: { account: 'accountId' } })
    const login = new Request('http://localhost/')
    Session.attach(login)
    login.session.set('accountId', 41, true)
    Session.getCookie(login)
    const id = login.session.id

    expect(await Session.endForAccount(41)).toBe(1)
    const after = new Request('http://localhost/', {
      headers: { cookie: `sId=${signSessionId(id)}` },
    })
    Session.attach(after)
    expect(after.session.get('accountId')).toBeUndefined()
  })

  test('a request holding the session it ended stores nothing on its way out', async () => {
    __setTestConfig({ sessions: { account: 'accountId' } })
    const login = new Request('http://localhost/')
    Session.attach(login)
    login.session.set('accountId', 42, true)
    Session.getCookie(login)
    const id = login.session.id

    const inFlight = new Request('http://localhost/', {
      headers: { cookie: `sId=${signSessionId(id)}` },
    })
    Session.attach(inFlight)
    expect(inFlight.session.get('accountId')).toBe(42)

    await Session.endForAccount(42)
    inFlight.session.set('lastPage', '/grades')
    expect(Session.getCookie(inFlight)).toBe('')
    expect(await Session.get(id)).toBeUndefined()
  })

  test('end, total and page work there too', async () => {
    const req = new Request('http://localhost/')
    Session.attach(req)
    req.session.set('n', 1)
    Session.getCookie(req)

    expect(await Session.total()).toBeGreaterThan(0)
    const page = await Session.page({
      search: req.session.id,
      page: 1,
      pageSize: 5,
      sortBy: 'id',
      sortOrder: 'ASC',
    })
    expect(page.rows.map(s => s.id)).toContain(req.session.id)
    expect(await Session.end(req.session.id)).toBe(true)
    expect(await Session.get(req.session.id)).toBeUndefined()
  })
})
