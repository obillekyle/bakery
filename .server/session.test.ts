import { describe, test, expect } from 'bun:test'
import { Session } from './session'

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
