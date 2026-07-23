import { describe, test, expect, beforeAll } from 'bun:test'
import { Bakery, getHostname, hostKey } from './bakery'
import { hostStore, getBakeryVersion } from './context'
import { initConfig } from './config'

beforeAll(async () => {
  await initConfig()
})

describe('Bakery', () => {
  test('has expected properties', () => {
    expect(Bakery.root).toBeDefined()
    expect(Bakery.cacheDir).toBeDefined()
    expect(Bakery.dataDir).toBeDefined()
    expect(Bakery.handlers).toBeDefined()
    expect(Bakery.handlers.fetch).toBeDefined()
    expect(Bakery.handlers.error).toBeDefined()
    expect(Bakery.handlers.websocket).toBeDefined()
  })

  test('shutdownHooks is an array', () => {
    expect(Array.isArray(Bakery.shutdownHooks)).toBe(true)
  })

  test('onShutdown registers hooks', () => {
    const initial = Bakery.shutdownHooks.length
    const noop = () => {}
    Bakery.onShutdown(noop)
    expect(Bakery.shutdownHooks.length).toBe(initial + 1)
    Bakery.shutdownHooks.pop()
  })
})

describe('getHostname', () => {
  test('extracts from host header', () => {
    const req = new Request('http://localhost/', {
      headers: { host: 'app.example.com:3000' },
    })
    expect(getHostname(req, { trustProxy: false } as any)).toBe('app.example.com')
  })

  test('extracts from x-forwarded-host with trustProxy', () => {
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-host': 'proxy.example.com' },
    })
    expect(getHostname(req, { trustProxy: true } as any)).toBe('proxy.example.com')
  })

  test('ignores x-forwarded-host without trustProxy', () => {
    const req = new Request('http://localhost/', {
      headers: {
        host: 'direct.example.com',
        'x-forwarded-host': 'proxy.example.com',
      },
    })
    expect(getHostname(req, { trustProxy: false } as any)).toBe('direct.example.com')
  })

  test('falls back to URL hostname', () => {
    const req = new Request('http://fallback.local:8080/')
    expect(getHostname(req, { trustProxy: false } as any)).toBe('fallback.local')
  })

  test('uses cached __hostname if present', () => {
    const req = new Request('http://localhost/')
    ;(req as any).__hostname = 'cached.host'
    expect(getHostname(req, { trustProxy: false } as any)).toBe('cached.host')
  })
})

describe('hostKey', () => {
  test('scopes path with hostStore hostname', async () => {
    await hostStore.run({ hostname: 'tenant.com', config: Bakery.config }, () => {
      expect(hostKey('/page')).toBe('tenant.com:/page')
    })
  })

  test('returns raw path outside hostStore', () => {
    expect(hostKey('/page')).toBe('/page')
  })
})

describe('getBakeryVersion', () => {
  test('returns a version string', () => {
    const version = getBakeryVersion()
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })
})
