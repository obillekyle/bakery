import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { __resetTestConfig, initConfig } from './core/config'
import { newSessionId, Session } from './session'
import {
  __forgetSessionKey,
  signSessionId,
  verifiedSessionId,
} from './session-signing'

beforeAll(async () => {
  await initConfig()
})

afterAll(() => {
  __resetTestConfig()
})

describe('signed session cookies', () => {
  test('a signed id verifies, and nothing else does', () => {
    const id = newSessionId()
    const value = signSessionId(id)
    expect(value.startsWith(`${id}.`)).toBe(true)
    expect(verifiedSessionId(value)).toBe(id)

    expect(verifiedSessionId(id)).toBe('')
    expect(verifiedSessionId('')).toBe('')
    expect(verifiedSessionId('.')).toBe('')
    expect(verifiedSessionId(`${id}.`)).toBe('')
    expect(verifiedSessionId(`x${value}`)).toBe('')
  })

  test('a cookie signed under one secret does not verify under another', () => {
    const id = newSessionId()
    const value = signSessionId(id, 'first secret')
    expect(verifiedSessionId(value, 'first secret')).toBe(id)
    expect(verifiedSessionId(value, 'second secret')).toBe('')
    // Nor under the kept key, which is what applies with no secret set.
    expect(verifiedSessionId(value)).toBe('')
  })

  test('the kept key outlives the process that made it', () => {
    // Read back from bakery/session.key: every worker, and the next boot,
    // signs with the same key, so a cookie survives a restart.
    const id = newSessionId()
    const before = signSessionId(id)
    __forgetSessionKey()
    expect(signSessionId(id)).toBe(before)
  })

  test('the built-in store gives an unsigned cookie a fresh session', () => {
    const planted = Session.create({
      id: newSessionId(),
      persistKeys: ['userId'],
      data: { userId: 'u_1' },
    })
    const unsigned = new Request('http://localhost/', {
      headers: { cookie: `sId=${planted.id}` },
    })
    expect(Session.from(unsigned).id).not.toBe(planted.id)

    const signed = new Request('http://localhost/', {
      headers: { cookie: `sId=${signSessionId(planted.id)}` },
    })
    expect(Session.from(signed).get('userId')).toBe('u_1')
  })
})
