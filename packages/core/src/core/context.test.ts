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
  /**
   * Prereleases count. This asserted `/^\d+\.\d+\.\d+$/` and passed for every
   * release the project ever cut — until the first one that was not stable:
   * `2.0.0-alpha.0` failed here, in the publish workflow's test step, on the
   * very first prerelease. The gate did its job (nothing reached npm), but the
   * assertion was wrong rather than the code.
   *
   * Matches what `scripts/release.ts` accepts as a version, so the two agree
   * on what this project can be numbered: core, optional `-prerelease`,
   * optional `+build`.
   */
  test('returns semver-like string, prereleases included', () => {
    const version = getAppVersion()
    expect(version).toMatch(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    )
  })

  test('the pattern above really does accept a prerelease', () => {
    // Pinned against the literal that broke, so a future tightening of the
    // regex fails here rather than in a release.
    const pattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
    expect('2.0.0-alpha.0').toMatch(pattern)
    expect('2.0.0-beta.12').toMatch(pattern)
    expect('1.2.3').toMatch(pattern)
    expect('v1.2.3').not.toMatch(pattern)
    expect('1.2').not.toMatch(pattern)
  })

  test('caches result', () => {
    const v1 = getAppVersion()
    const v2 = getAppVersion()
    expect(v1).toBe(v2)
  })
})
