import { describe, expect, test } from 'bun:test'
import {
  type Access,
  type AccessFn,
  accessFromPredicate,
  accessFromUsers,
  canWrite,
  resolveAccess,
} from './access'

const USERS = {
  ops: { credential: 'ops-key', access: 'write' as Access },
  oncall: { credential: 'oncall-key', access: 'read' as Access },
}

const get = (headers?: HeadersInit, path = '/api/_db/schema') =>
  new Request(`http://localhost${path}`, { headers })

const post = (headers?: HeadersInit, path = '/api/_db/row') =>
  new Request(`http://localhost${path}`, { method: 'POST', headers })

describe('nothing configured admits nobody', () => {
  test('no users, no predicate', async () => {
    expect(await resolveAccess(get(), {})).toBe(false)
    expect(await resolveAccess(get({ 'x-db-key': 'anything' }), {})).toBe(false)
  })

  test('an empty users map is not an open door', async () => {
    expect(await resolveAccess(get({ 'x-db-key': '' }), { users: {} })).toBe(
      false,
    )
  })

  test('a user with an empty credential cannot be matched', async () => {
    // `credential: env.MISSING_KEY` with the variable unset must mean "off",
    // not "matches the empty string".
    const users = { ghost: { credential: '', access: 'write' as Access } }
    expect(await resolveAccess(get({ 'x-db-key': '' }), { users })).toBe(false)
    expect(accessFromUsers(get({ 'x-db-key': '' }), users)).toBe(false)
  })
})

describe('users grant their own level', () => {
  test('the write key writes and the read key does not', () => {
    expect(accessFromUsers(get({ 'x-db-key': 'ops-key' }), USERS)).toBe('write')
    expect(accessFromUsers(get({ 'x-db-key': 'oncall-key' }), USERS)).toBe(
      'read',
    )
  })

  test('a wrong key grants nothing', () => {
    expect(accessFromUsers(get({ 'x-db-key': 'nope' }), USERS)).toBe(false)
    expect(accessFromUsers(get(), USERS)).toBe(false)
  })

  test('header, Bearer and query all present the key on a read', () => {
    expect(accessFromUsers(get({ 'x-db-key': 'ops-key' }), USERS)).toBe('write')
    expect(
      accessFromUsers(get({ authorization: 'Bearer ops-key' }), USERS),
    ).toBe('write')
    expect(
      accessFromUsers(get(undefined, '/api/_db/schema?db-key=ops-key'), USERS),
    ).toBe('write')
  })
})

describe('a URL credential cannot authorise a write', () => {
  /**
   * A credential in a URL travels with any link. `checkCsrf` is an `Origin`
   * check rather than a token, and it *passes* when `Origin` is absent or the
   * literal string `"null"` — which is what a sandboxed iframe sends. Requiring
   * a header on a state-changing request means the caller had to run script on
   * this origin.
   */
  test('?db-key= is refused on POST but accepted on GET', () => {
    const url = '/api/_db/row?db-key=ops-key'
    expect(accessFromUsers(get(undefined, url), USERS)).toBe('write')
    expect(accessFromUsers(post(undefined, url), USERS)).toBe(false)
  })

  test('the same key in a header is fine on POST', () => {
    expect(accessFromUsers(post({ 'x-db-key': 'ops-key' }), USERS)).toBe(
      'write',
    )
    expect(
      accessFromUsers(post({ authorization: 'Bearer ops-key' }), USERS),
    ).toBe('write')
  })

  test('a header present but wrong does not fall back to the query', () => {
    // The header is preferred, so a wrong header must lose rather than let the
    // URL answer for it.
    const req = post({ 'x-db-key': 'wrong' }, '/api/_db/row?db-key=ops-key')
    expect(accessFromUsers(req, USERS)).toBe(false)
  })
})

describe('the predicate must answer with an exact level', () => {
  const ask = (fn: AccessFn) => accessFromPredicate(get(), fn)

  test('write and read are honoured', async () => {
    expect(await ask(() => 'write')).toBe('write')
    expect(await ask(() => 'read')).toBe('read')
    expect(await ask(async (): Promise<Access> => 'write')).toBe('write')
  })

  test('false denies', async () => {
    expect(await ask(() => false)).toBe(false)
  })

  test('true is a DENIAL, not a grant', async () => {
    // The single most important assertion here. A predicate written against the
    // old boolean API means "let them in" and cannot mean "let them write";
    // guessing which is exactly what this type exists to prevent.
    expect(await ask((() => true) as unknown as AccessFn)).toBe(false)
  })

  test('any other truthy answer is denied', async () => {
    for (const value of ['WRITE', 'admin', 1, {}, [], 'readonly', ' read']) {
      expect(await ask((() => value) as unknown as AccessFn)).toBe(false)
    }
  })

  test('a throwing predicate denies rather than escaping', async () => {
    expect(
      await ask(() => {
        throw new Error('identity service down')
      }),
    ).toBe(false)
    expect(
      await ask(async () => {
        throw new Error('session store unreachable')
      }),
    ).toBe(false)
    expect(
      await ask((() => Promise.reject(new Error('no'))) as unknown as AccessFn),
    ).toBe(false)
  })
})

describe('both doors, higher wins', () => {
  test('the predicate can raise a key holder to write', async () => {
    const access = await resolveAccess(get({ 'x-db-key': 'oncall-key' }), {
      users: USERS,
      authorize: () => 'write',
    })
    expect(access).toBe('write')
  })

  test('a key can raise a read-only session to write', async () => {
    const access = await resolveAccess(get({ 'x-db-key': 'ops-key' }), {
      users: USERS,
      authorize: () => 'read',
    })
    expect(access).toBe('write')
  })

  test('neither admitting is still a denial', async () => {
    const access = await resolveAccess(get({ 'x-db-key': 'nope' }), {
      users: USERS,
      authorize: () => false,
    })
    expect(access).toBe(false)
  })

  test('a denying predicate does not veto a valid key', async () => {
    // Higher wins — the doors are alternatives, not a conjunction. Anyone
    // wanting a veto writes it into the predicate and issues no key.
    const access = await resolveAccess(get({ 'x-db-key': 'ops-key' }), {
      users: USERS,
      authorize: () => false,
    })
    expect(access).toBe('write')
  })
})

describe('every user entry is compared', () => {
  test('a match late in the map is found', () => {
    // No early exit: the comparison is constant-time per entry, and stopping at
    // the first match would make response time depend on a key's position.
    const many: Record<string, { credential: string; access: Access }> = {}
    for (let i = 0; i < 40; i++) {
      many[`u${i}`] = { credential: `key-${i}`, access: 'read' }
    }
    many.last = { credential: 'final-key', access: 'write' }

    expect(accessFromUsers(get({ 'x-db-key': 'final-key' }), many)).toBe(
      'write',
    )
  })

  test('two users sharing a credential grant the higher level', () => {
    const shared = {
      a: { credential: 'same', access: 'read' as Access },
      b: { credential: 'same', access: 'write' as Access },
    }
    expect(accessFromUsers(get({ 'x-db-key': 'same' }), shared)).toBe('write')
  })
})

describe('canWrite', () => {
  test('only write writes', () => {
    expect(canWrite('write')).toBe(true)
    expect(canWrite('read')).toBe(false)
    expect(canWrite(false)).toBe(false)
  })
})
