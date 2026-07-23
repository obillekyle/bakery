import { describe, test, expect, beforeEach } from 'bun:test'
import { initConfig, clearHostConfigCache, getConfig, resolveHostConfig } from './config'
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

describe('clearHostConfigCache', () => {
  test('clears without error', () => {
    clearHostConfigCache()
    expect(true).toBe(true)
  })
})
