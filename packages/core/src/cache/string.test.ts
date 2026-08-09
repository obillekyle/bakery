import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Strings } from './string'

describe('StringCache', () => {
  test('set and getValue', () => {
    Strings.set('url:/page', 'file:/src/page.html')
    expect(Strings.getValue('url:/page')).toBe('file:/src/page.html')
  })

  test('getKey reverse lookup', () => {
    Strings.set('k:v', 'reverse-test')
    expect(Strings.getKey('reverse-test')).toBe('k:v')
  })

  test('getValue returns undefined for missing', () => {
    expect(Strings.getValue('nonexistent')).toBeUndefined()
  })

  test('getKey returns undefined for missing', () => {
    expect(Strings.getKey('nonexistent')).toBeUndefined()
  })

  test('set overwrites existing key value', () => {
    Strings.set('overwrite-key', 'old')
    Strings.set('overwrite-key', 'new')
    expect(Strings.getValue('overwrite-key')).toBe('new')
  })

  test('set throws on value collision', () => {
    Strings.set('coll-a', 'collision-value')
    expect(() => {
      Strings.set('coll-b', 'collision-value')
    }).toThrow('Collision')
  })

  test('deleteByKey removes entry', () => {
    Strings.set('del-me', 'del-val')
    Strings.deleteByKey('del-me')
    expect(Strings.getValue('del-me')).toBeUndefined()
    expect(Strings.getKey('del-val')).toBeUndefined()
  })

  test('deleteByKey returns false for missing', () => {
    expect(Strings.deleteByKey('never-existed')).toBe(false)
  })

  test('flushToDisk persists to SQLite', () => {
    Strings.set('persist-key', 'persist-val')
    Strings.flushToDisk()
  })

  test('set is idempotent for same key-value pair', () => {
    Strings.set('idempotent', 'same')
    Strings.set('idempotent', 'same')
    expect(Strings.getValue('idempotent')).toBe('same')
  })
})
