import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
  clearHostConfigCache,
  getConfig,
  resolveHostConfig,
} from './config'
import { hostStore } from './context'
import { Bakery } from './bakery'

describe('initConfig', () => {
  beforeEach(() => {
    clearHostConfigCache()
  })

  test('returns frozen config object', async () => {
    const config = await initConfig()
    expect(config).toBeDefined()
    expect(Object.isFrozen(config)).toBe(true)
  })

  test('returns same instance on second call (caching)', async () => {
    const config1 = await initConfig()
    const config2 = await initConfig()
    expect(config1).toBe(config2)
  })

  test('config has expected defaults', async () => {
    const config = await initConfig()
    expect(config.port).toBeDefined()
    expect(config.host).toBeDefined()
    expect(config.importMap).toBeDefined()
    expect(typeof config.importMap).toBe('object')
  })
})

describe('getConfig', () => {
  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
  })

  test('returns config after init', () => {
    const config = getConfig()
    expect(config).toBeDefined()
  })

  test('throws if not initialized', () => {
    clearHostConfigCache()
    expect(() => getConfig()).toThrow('not been initialized')
  })
})

describe('resolveHostConfig', () => {
  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
  })

  test('returns base config for unknown host', () => {
    const config = resolveHostConfig('unknown.example.com')
    expect(config).toBe(getConfig())
  })

  test('returns base config when no hosts configured', () => {
    const config = resolveHostConfig('any-host')
    expect(config).toBeDefined()
  })
})

describe('resolveHostConfig — hostname case', () => {
  // Hostnames are case-insensitive and nothing normalises the Host header, so
  // `EXAMPLE.com` used to miss an `example.com` entry and quietly serve the
  // base config instead.
  const HEAD = '<meta name="host-probe" content="example">'

  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
    __setTestConfig({ hosts: { 'example.com': { head: HEAD } } })
  })

  afterEach(() => {
    __resetTestConfig()
    clearHostConfigCache()
  })

  test('matches a differently-cased Host header', () => {
    expect(resolveHostConfig('example.com').head).toBe(HEAD)
    expect(resolveHostConfig('EXAMPLE.com').head).toBe(HEAD)
    expect(resolveHostConfig('Example.COM').head).toBe(HEAD)
  })

  test('every spelling shares one cache entry', () => {
    const lower = resolveHostConfig('example.com')
    expect(resolveHostConfig('EXAMPLE.COM')).toBe(lower)
  })

  test('a differently-cased config key is matched too', () => {
    __setTestConfig({ hosts: { 'Mixed.Case.Example': { head: HEAD } } })
    expect(resolveHostConfig('mixed.case.example').head).toBe(HEAD)
  })

  test('unknown hostnames are still not cached', () => {
    // Caching misses would let any client grow the map one made-up hostname at
    // a time. Under __setTestConfig, getConfig() builds a fresh frozen object
    // per call — so a cached miss would return the *same* object twice, and a
    // genuine miss returns two different ones.
    const first = resolveHostConfig('nonsense-1.invalid')
    const second = resolveHostConfig('nonsense-1.invalid')

    expect(first.head).toBe('')
    expect(second).not.toBe(first)
  })

  test('a prototype member is not mistaken for a host entry', () => {
    // A bare `hosts[hostname]` lookup returns a truthy prototype member for
    // `Host: constructor`, which then gets merged as if it were a host entry —
    // and cached, since only real entries are. Merging a function contributes
    // no keys, so `head` alone cannot see the difference; the cache can.
    const first = resolveHostConfig('constructor')
    const second = resolveHostConfig('constructor')

    expect(first.head).toBe('')
    expect(second).not.toBe(first)
    expect(resolveHostConfig('toString').head).toBe('')
  })
})

describe('clearHostConfigCache', () => {
  test('clears without error', () => {
    clearHostConfigCache()
    expect(true).toBe(true)
  })
})
