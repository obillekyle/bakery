import { describe, expect, test } from 'bun:test'
import {
  credentialMatches,
  readCredential,
  requestHasCredential,
} from './credential'

const req = (init: RequestInit = {}, path = '/x') =>
  new Request(`http://localhost${path}`, init)

describe('credentialMatches', () => {
  test('an unset or empty configured value is off, never open', () => {
    expect(credentialMatches(undefined, 'anything')).toBe(false)
    expect(credentialMatches('', 'anything')).toBe(false)
    // Even matching empties: an empty secret is not a usable credential.
    expect(credentialMatches('', '')).toBe(false)
  })

  test('a missing presentation never matches', () => {
    expect(credentialMatches('secret', null)).toBe(false)
    expect(credentialMatches('secret', undefined)).toBe(false)
  })

  test('exact match admits; a differing length or byte does not', () => {
    expect(credentialMatches('warehouse-9', 'warehouse-9')).toBe(true)
    expect(credentialMatches('warehouse-9', 'warehouse-8')).toBe(false)
    // Length mismatch is the branch that must not reach timingSafeEqual, which
    // throws on unequal lengths.
    expect(credentialMatches('warehouse-9', 'warehouse-99')).toBe(false)
    expect(credentialMatches('warehouse-9', 'warehouse')).toBe(false)
  })
})

describe('readCredential', () => {
  test('prefers x-<name>, then Bearer, then query', () => {
    expect(
      readCredential(req({ headers: { 'x-db-key': 'H' } }), 'db-key'),
    ).toBe('H')
    expect(
      readCredential(req({ headers: { authorization: 'Bearer B' } }), 'db-key'),
    ).toBe('B')
    expect(readCredential(req({}, '/x?db-key=Q'), 'db-key')).toBe('Q')
  })

  test('the header wins when more than one spelling is present', () => {
    const r = req(
      { headers: { 'x-db-key': 'H', authorization: 'Bearer B' } },
      '/x?db-key=Q',
    )
    expect(readCredential(r, 'db-key')).toBe('H')
  })

  test('null when nothing is presented', () => {
    expect(readCredential(req(), 'db-key')).toBeNull()
  })

  test('the name scopes the lookup', () => {
    const r = req({ headers: { 'x-analytics-key': 'A' } })
    expect(readCredential(r, 'analytics-key')).toBe('A')
    expect(readCredential(r, 'db-key')).toBeNull()
  })
})

describe('requestHasCredential', () => {
  test('composes read + compare, and stays off when unconfigured', () => {
    expect(
      requestHasCredential(
        req({ headers: { 'x-db-key': 'secret' } }),
        'secret',
        'db-key',
      ),
    ).toBe(true)
    expect(
      requestHasCredential(
        req({ headers: { 'x-db-key': 'secret' } }),
        undefined,
        'db-key',
      ),
    ).toBe(false)
    expect(
      requestHasCredential(
        req({ headers: { 'x-db-key': 'nope' } }),
        'secret',
        'db-key',
      ),
    ).toBe(false)
  })
})
