import { expect, test, describe, beforeEach, beforeAll } from 'bun:test'
import { Bakery, getHostname, hostKey, hostStore } from '../core/bakery'
import { resolveHostConfig, clearHostConfigCache, initConfig, getConfig } from '../core/config'
import { setLogCallback } from '../logger'

describe('Multi-Host Architecture', () => {
  beforeEach(async () => {
    clearHostConfigCache()
    await initConfig()
  })

  describe('getHostname()', () => {
    test('extracts hostname from x-forwarded-host header', () => {
      const req = new Request('http://localhost:3000/path', {
        headers: { 'x-forwarded-host': 'tenant.example.com' },
      })
      expect(getHostname(req, { trustProxy: true } as any)).toBe('tenant.example.com')
    })

    test('extracts hostname from host header when x-forwarded-host is missing', () => {
      const req = new Request('http://localhost:3000/path', {
        headers: { host: 'app.mycompany.io:8080' },
      })
      expect(getHostname(req)).toBe('app.mycompany.io')
    })

    test('falls back to req.url hostname when headers are absent', () => {
      const req = new Request('http://fallback.local:3000/path')
      expect(getHostname(req)).toBe('fallback.local')
    })

    test('getHostname extracts any hostname, resolveHostConfig handles unknown hosts', () => {
      const req = new Request('http://unknown.host/test')
      expect(getHostname(req)).toBe('unknown.host')
      expect(resolveHostConfig('unknown.host')).toBe(getConfig())
    })
  })

  describe('hostKey()', () => {
    test('scopes path with current hostStore hostname', async () => {
      await hostStore.run({ hostname: 'client-a.com', config: Bakery.config }, async () => {
        expect(hostKey('/index.html')).toBe('client-a.com:/index.html')
      })
    })

    test('returns raw path when outside hostStore scope or hostname is empty', () => {
      expect(hostKey('/index.html')).toBe('/index.html')
    })
  })

  describe('AsyncContext (hostStore.run)', () => {
    test('preserves host context across async timeouts and promises', async () => {
      const results: string[] = []

      const taskA = hostStore.run({ hostname: 'host-a.com', config: Bakery.config }, async () => {
        await new Promise(r => setTimeout(r, 20))
        results.push(`A:${hostStore.getStore()?.hostname}`)
      })

      const taskB = hostStore.run({ hostname: 'host-b.com', config: Bakery.config }, async () => {
        await new Promise(r => setTimeout(r, 10))
        results.push(`B:${hostStore.getStore()?.hostname}`)
      })

      await Promise.all([taskA, taskB])
      expect(results).toContain('A:host-a.com')
      expect(results).toContain('B:host-b.com')
    })
  })

  describe('Host-Scoped Error Logging', () => {
    test('Bakery.config.onError logs with virtual hostname when inside hostStore context', async () => {
      let loggedBy = ''
      setLogCallback(entry => {
        if (entry.msg === 'Test 404 Error') {
          loggedBy = entry.by!
        }
      })

      await hostStore.run({ hostname: 'paldo.dev', config: Bakery.config }, async () => {
        Bakery.config.onError({ errorBody: 'Test 404 Error' } as any)
      })

      await new Promise(r => setTimeout(r, 10))
      expect(loggedBy).toBe('paldo.dev')
      setLogCallback(() => {})
    })
  })
})
