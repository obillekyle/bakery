import { describe, test, expect, afterAll, beforeAll } from 'bun:test'
import { join } from 'node:path'
import { Bakery, getHostname, hostKey } from './bakery'
import { hostStore, getBakeryVersion } from './context'
import { __resetTestConfig, __setTestConfig, initConfig } from './config'

beforeAll(async () => {
  await initConfig()
})

describe('Bakery', () => {
  test('has expected properties', () => {
    expect(Bakery.root).toBeDefined()
    expect(Bakery.cacheDir).toBeDefined()
    expect(Bakery.dataDir).toBeDefined()
    expect(Bakery.publicRoot).toBe(join(Bakery.root, 'public').replaceAll('\\', '/'))
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
  const hosts = { 'tenant.com': {} } satisfies Record<string, HostEntry>

  afterAll(() => __resetTestConfig())

  test('scopes path with a configured hostStore hostname', async () => {
    __setTestConfig({ hosts })
    await hostStore.run({ hostname: 'tenant.com', config: Bakery.config }, () => {
      expect(hostKey('/page')).toBe('tenant.com:/page')
    })
  })

  test('returns raw path outside hostStore', () => {
    __setTestConfig({ hosts })
    expect(hostKey('/page')).toBe('/page')
  })

  /**
   * The key becomes a cache *filename*, and `getOrCreateCachedFile` writes
   * three files per entry with no bound and no eviction — so a key derived
   * straight from the `Host` header is an unauthenticated disk and inode fill.
   * `resolveHostConfig` already refuses to cache an unknown hostname for this
   * exact reason; the file caches were missed.
   */
  test('unconfigured hostnames collapse to one key instead of one each', async () => {
    __setTestConfig({ hosts })
    const keys = new Set<string>()
    for (let i = 0; i < 25; i++) {
      await hostStore.run(
        { hostname: `filler-${i}.example`, config: Bakery.config },
        () => {
          keys.add(hostKey('/index.html'))
        },
      )
    }
    expect([...keys]).toEqual(['/index.html'])
  })

  test('a configured host is matched case-insensitively, as one key', async () => {
    __setTestConfig({ hosts })
    const keys = new Set<string>()
    for (const hostname of ['tenant.com', 'TENANT.com', 'Tenant.Com']) {
      await hostStore.run({ hostname, config: Bakery.config }, () => {
        keys.add(hostKey('/index.html'))
      })
    }
    expect([...keys]).toEqual(['tenant.com:/index.html'])
  })

  test('with no hosts configured every request shares the default key', async () => {
    __setTestConfig({ hosts: {} })
    await hostStore.run({ hostname: 'anything.example', config: Bakery.config }, () => {
      expect(hostKey('/index.html')).toBe('/index.html')
    })
  })
})

describe('getBakeryVersion', () => {
  test('returns a version string', () => {
    const version = getBakeryVersion()
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
  })
})
