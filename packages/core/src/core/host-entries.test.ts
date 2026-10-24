import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  clearHeadBodyCache,
  DOMTools,
  initHostImportMaps,
  initImportMap,
} from '../utils/http/dom'
import { hostKey, hostStore } from './bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  checkHosts,
  clearHostConfigCache,
  getConfig,
  hostEntryKey,
  initConfig,
  resolveHostConfig,
  resolveHostname,
} from './config'

/**
 * `hosts` keys read against `domains`: `'@'` for a domain itself, a bare
 * label for that subdomain, `'*'` for any other, beside exact names, which
 * match first.
 *
 * A key is more than routing: the tenant it resolves to prefixes sessions and
 * file caches (`hostKey`) and keys the resolved-config cache, so each case
 * checks the tenant as well as the entry, and `'*'` is held to one tenant per
 * domain however many subdomains arrive.
 */
const HOSTS: Record<string, HostEntry> = {
  '@': { head: 'apex' },
  admin: { head: 'admin', mount: '/admin' },
  kit: { head: 'kit', mount: '/kit/' },
  '*': { head: 'any' },
  'special.bpc.edu.ph': { head: 'exact' },
  'admin.localhost': { head: 'exact admin' },
}

async function configure(overrides: Partial<ProcessedAppConfig>) {
  clearHostConfigCache()
  await initConfig()
  __setTestConfig(overrides)
}

afterEach(() => {
  __resetTestConfig()
  clearHostConfigCache()
})

/** The key, the tenant and the head a hostname resolves to. */
const resolved = (hostname: string) =>
  `${hostEntryKey(hostname) || '-'} | ${resolveHostname(hostname) || '-'} | ${resolveHostConfig(hostname).head || '-'}`

describe('which entry a hostname gets', () => {
  beforeEach(() => configure({ domains: 'bpc.edu.ph', hosts: HOSTS }))

  test("a domain itself is '@', localhost included", () => {
    expect(resolved('bpc.edu.ph')).toBe('@ | bpc.edu.ph | apex')
    expect(resolved('localhost')).toBe('@ | localhost | apex')
  })

  test('one label in front of a domain is that label', () => {
    expect(resolved('admin.bpc.edu.ph')).toBe('admin | admin.bpc.edu.ph | admin')
    expect(resolved('kit.localhost')).toBe('kit | kit.localhost | kit')
    expect(resolved('ADMIN.Bpc.Edu.Ph')).toBe('admin | admin.bpc.edu.ph | admin')
  })

  test("anything else in front of a domain is '*', one tenant per domain", () => {
    expect(resolved('ma.bpc.edu.ph')).toBe('* | *.bpc.edu.ph | any')
    expect(resolved('sti.bpc.edu.ph')).toBe('* | *.bpc.edu.ph | any')
    expect(resolved('a.b.bpc.edu.ph')).toBe('* | *.bpc.edu.ph | any')
    expect(resolved('ma.localhost')).toBe('* | *.localhost | any')
  })

  test("a bare label names one subdomain, not its children", () => {
    expect(resolved('admin.x.bpc.edu.ph')).toBe('* | *.bpc.edu.ph | any')
  })

  test('an exact key wins over every other form', () => {
    expect(resolved('special.bpc.edu.ph')).toBe(
      'special.bpc.edu.ph | special.bpc.edu.ph | exact',
    )
    expect(resolved('admin.localhost')).toBe(
      'admin.localhost | admin.localhost | exact admin',
    )
  })

  test('a hostname under no domain, or an IP address, gets the base config', () => {
    for (const hostname of ['example.org', 'kit.example.org', '127.0.0.1', '[']) {
      expect(resolved(hostname)).toBe('- | - | -')
      expect(resolveHostConfig(hostname)).not.toBe(resolveHostConfig(hostname))
    }
  })

  test("the entry's mount reaches the resolved config, normalized", () => {
    expect(resolveHostConfig('kit.bpc.edu.ph').mount).toBe('/kit')
    expect(resolveHostConfig('admin.bpc.edu.ph').mount).toBe('/admin')
    expect(resolveHostConfig('bpc.edu.ph').mount).toBeUndefined()
  })

  test("made-up subdomains share one cached config instead of growing the cache", () => {
    const first = resolveHostConfig('s0.bpc.edu.ph')
    for (let i = 1; i < 100; i++) {
      expect(resolveHostConfig(`s${i}.bpc.edu.ph`)).toBe(first)
    }
  })

  test('the tenant is what sessions and file caches are keyed by', () => {
    const keyOn = (hostname: string) =>
      hostStore.run({ hostname, config: getConfig() }, () => hostKey('/p'))
    expect(keyOn('ma.bpc.edu.ph')).toBe('*.bpc.edu.ph:/p')
    expect(keyOn('sti.bpc.edu.ph')).toBe('*.bpc.edu.ph:/p')
    expect(keyOn('admin.bpc.edu.ph')).toBe('admin.bpc.edu.ph:/p')
    expect(keyOn('example.org')).toBe('/p')
  })
})

describe('domains', () => {
  test('a nested domain is tried before the one it sits in', async () => {
    await configure({ domains: ['edu.ph', 'bpc.edu.ph'], hosts: HOSTS })
    expect(resolved('kit.bpc.edu.ph')).toBe('kit | kit.bpc.edu.ph | kit')
    expect(resolved('bpc.edu.ph')).toBe('@ | bpc.edu.ph | apex')
    expect(resolved('other.edu.ph')).toBe('* | *.edu.ph | any')
  })

  test('a function is asked on each request, so a changed domain applies at once', async () => {
    let current = 'a.test'
    await configure({ domains: () => current, hosts: HOSTS })
    expect(resolved('kit.a.test')).toBe('kit | kit.a.test | kit')
    expect(resolved('kit.b.test')).toBe('- | - | -')

    current = 'b.test'
    expect(resolved('kit.b.test')).toBe('kit | kit.b.test | kit')
    expect(resolved('kit.a.test')).toBe('- | - | -')
  })

  test("an answer that is no domain matches nothing, and localhost still counts", async () => {
    await configure({ domains: () => ['not a domain', '10.0.0.1', ''], hosts: HOSTS })
    expect(resolved('kit.localhost')).toBe('kit | kit.localhost | kit')
    expect(resolved('kit.not a domain')).toBe('- | - | -')
  })

  test('without domains, localhost alone carries the forms', async () => {
    await configure({ hosts: HOSTS })
    expect(resolved('kit.localhost')).toBe('kit | kit.localhost | kit')
    expect(resolved('kit.bpc.edu.ph')).toBe('- | - | -')
  })
})

describe('checkHosts', () => {
  const check = (overrides: Partial<ProcessedAppConfig>) => () =>
    checkHosts({ ...getConfig(), ...overrides } as ProcessedAppConfig)

  beforeEach(() => configure({}))

  test('passes good domains and mounts', () => {
    expect(check({ domains: 'bpc.edu.ph', hosts: HOSTS })).not.toThrow()
    expect(check({ domains: ['bpc.edu.ph', 'localhost'] })).not.toThrow()
  })

  test('names a domain that is no domain', () => {
    expect(check({ domains: 'bpc..edu.ph' })).toThrow(
      'domains "bpc..edu.ph" is not a domain',
    )
    expect(check({ domains: ['bpc.edu.ph', '10.0.0.1'] })).toThrow(
      'domains[1] "10.0.0.1" is not a domain',
    )
    expect(check({ domains: ['kit.*'] })).toThrow('domains[0] "kit.*"')
  })

  test("names a host entry's mount that cannot mean anything", () => {
    expect(check({ hosts: { kit: { mount: 'kit' } } })).toThrow(
      "hosts['kit'].mount must be a path starting with '/'",
    )
    expect(check({ hosts: { '*': { mount: '/_kit' } } })).toThrow(
      "hosts['*'].mount '/_kit' is under /_",
    )
  })

  test('does not ask a domains function at boot, whose answer can change', () => {
    let asked = 0
    expect(
      check({
        domains: () => {
          asked++
          return 'bpc.edu.ph'
        },
      }),
    ).not.toThrow()
    expect(asked).toBe(0)
  })
})

describe('per-host import maps', () => {
  test("a '*' entry's map reaches its subdomains, and a key's case no longer matters", async () => {
    await configure({
      domains: 'bpc.edu.ph',
      importMap: {},
      hosts: {
        '*': { importMap: { site: '/site/entry.js' } },
        'Tenant.Example': { importMap: { tenant: '/tenant/entry.js' } },
      },
    })
    await initImportMap()
    initHostImportMaps()

    const mapOn = (hostname: string) =>
      hostStore.run({ hostname, config: getConfig() }, () => {
        const tag = DOMTools.importMap()
        return JSON.parse(tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>')))
          .imports as Record<string, string>
      })

    expect(mapOn('ma.bpc.edu.ph').site).toBe('/site/entry.js')
    expect(mapOn('tenant.example').tenant).toBe('/tenant/entry.js')
    expect(mapOn('admin.example.org').site).toBeUndefined()
    clearHeadBodyCache()
  })
})
