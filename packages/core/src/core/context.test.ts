import { describe, expect, test } from 'bun:test'
import { getAppVersion, hostStore } from './context'

describe('hostStore', () => {
  test('runs callback in AsyncLocalStorage context', async () => {
    await hostStore.run({ hostname: 'test.com', config: {} as any }, () => {
      expect(hostStore.getStore()?.hostname).toBe('test.com')
    })
  })

  test('isolates concurrent contexts', async () => {
    const results: string[] = []

    const taskA = hostStore.run(
      { hostname: 'a.com', config: {} as any },
      async () => {
        await new Promise(r => setTimeout(r, 10))
        results.push(hostStore.getStore()?.hostname || '')
      },
    )

    const taskB = hostStore.run(
      { hostname: 'b.com', config: {} as any },
      async () => {
        await new Promise(r => setTimeout(r, 5))
        results.push(hostStore.getStore()?.hostname || '')
      },
    )

    await Promise.all([taskA, taskB])
    expect(results).toContain('a.com')
    expect(results).toContain('b.com')
  })

  test('returns undefined outside context', () => {
    expect(hostStore.getStore()).toBeUndefined()
  })

  test('config is accessible within context', async () => {
    const mockConfig = { port: 4000 } as any
    await hostStore.run({ hostname: 'x.com', config: mockConfig }, () => {
      expect(hostStore.getStore()?.config.port).toBe(4000)
    })
  })
})

describe('getAppVersion', () => {
  test('returns semver-like string', () => {
    const version = getAppVersion()
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('caches result', () => {
    const v1 = getAppVersion()
    const v2 = getAppVersion()
    expect(v1).toBe(v2)
  })
})
