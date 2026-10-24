import { describe, expect, test } from 'bun:test'
import {
  checkHostMounts,
  compileHostMounts,
  findHostMount,
  type HostMount,
  hostPattern,
  mountedPath,
} from './host-mounts'

const matches = (host: string, hostname: string) =>
  hostPattern(host).test(hostname)

describe('hostPattern', () => {
  test("a fixed first label matches it under any domain: 'kit.*'", () => {
    expect(matches('kit.*', 'kit.localhost')).toBe(true)
    expect(matches('kit.*', 'kit.bpc.edu.ph')).toBe(true)
    expect(matches('kit.*', 'kit.example.com')).toBe(true)
  })

  test('the wildcard stands for whole labels, at least one', () => {
    expect(matches('kit.*', 'kit')).toBe(false)
    expect(matches('kit.*', 'kits.localhost')).toBe(false)
    expect(matches('kit.*', 'xkit.localhost')).toBe(false)
    expect(matches('kit.*', 'a.kit.localhost')).toBe(false)
  })

  test('a leading wildcard matches any subdomain of a name', () => {
    expect(matches('*.docs.example.com', 'a.docs.example.com')).toBe(true)
    expect(matches('*.docs.example.com', 'a.b.docs.example.com')).toBe(true)
    expect(matches('*.docs.example.com', 'docs.example.com')).toBe(false)
  })

  test('a name without a wildcard matches only itself, in any case', () => {
    expect(matches('kit.localhost', 'kit.localhost')).toBe(true)
    expect(matches('KIT.Localhost', 'kit.localhost')).toBe(true)
    expect(matches('kit.localhost', 'kit.localhost.evil.test')).toBe(false)
  })

  test('refuses an empty label and a wildcard inside a label', () => {
    expect(() => hostPattern('', 'h')).toThrow("h '' is not a hostname")
    expect(() => hostPattern('kit..com', 'h')).toThrow('no empty label')
    expect(() => hostPattern('k*t.example.com', 'h')).toThrow(
      "has the label 'k*t'",
    )
    expect(() => hostPattern('kit.example.com/x', 'h')).toThrow(
      "has the label 'com/x'",
    )
  })
})

describe('compileHostMounts', () => {
  test('normalizes the path to a leading slash and no trailing one', () => {
    const [mount] = compileHostMounts([{ host: 'kit.*', path: '/kit/' }])
    expect(mount.path).toBe('/kit')
  })

  test('hands a function the hostname lowercased and without the port', () => {
    const seen: string[] = []
    const mounts = compileHostMounts([
      {
        host: hostname => {
          seen.push(hostname)
          return hostname === 'kit.localhost'
        },
        path: '/kit',
      },
    ])
    expect(findHostMount(mounts, 'KIT.localhost')?.path).toBe('/kit')
    expect(seen).toEqual(['kit.localhost'])
  })

  test('the first entry that matches wins', () => {
    const mounts = compileHostMounts([
      { host: 'kit.localhost', path: '/kit/preview' },
      { host: 'kit.*', path: '/kit' },
    ])
    expect(findHostMount(mounts, 'kit.localhost')?.path).toBe('/kit/preview')
    expect(findHostMount(mounts, 'kit.example.com')?.path).toBe('/kit')
    expect(findHostMount(mounts, 'admin.example.com')).toBeNull()
  })

  test('compiles an array once', () => {
    const mounts: HostMount[] = [{ host: 'kit.*', path: '/kit' }]
    expect(compileHostMounts(mounts)).toBe(compileHostMounts(mounts))
  })

  // Each refusal names the entry and the field, the way a bad rate limit
  // does, because the message is all a failed boot has to say.
  const refused: [unknown, string][] = [
    [
      [{ host: 'kit.*', path: 'kit' }],
      "hostMounts[0].path must be a path starting with '/'",
    ],
    [[{ host: 'kit.*', path: '/' }], "hostMounts[0].path '/' is the whole app"],
    [[{ host: 'kit.*', path: '/kit//x' }], "has an empty, '.' or '..' segment"],
    [
      [{ host: 'kit.*', path: '/kit/../admin' }],
      "has an empty, '.' or '..' segment",
    ],
    [[{ host: 'kit.*', path: '/k?t' }], "holds no '?', '#', '*' or '\\'"],
    [
      [{ host: 'kit.*', path: '/_kit' }],
      'is under /_, which every host serves as it is',
    ],
    [[{ host: 'kit.*', path: '/api' }], 'is under /api/'],
    [[{ host: 'kit.*', path: '/api/docs' }], 'is under /api/'],
    [[{ host: 'kit.*', path: '/.well-known' }], 'is under /.well-known/'],
    [[{ host: 42, path: '/kit' }], 'hostMounts[0].host must be a hostname'],
    [
      [
        { host: 'kit.*', path: '/kit' },
        { host: 'k*t', path: '/kit' },
      ],
      'hostMounts[1].host',
    ],
    [[null], 'hostMounts[0] must be { host, path }'],
    [{ host: 'kit.*', path: '/kit' }, 'hostMounts must be an array'],
  ]
  for (const [mounts, message] of refused) {
    test(`refuses ${JSON.stringify(mounts)}`, () => {
      expect(() => compileHostMounts(mounts as HostMount[])).toThrow(message)
    })
  }

  test('a path that only starts with a reserved name is not reserved', () => {
    expect(compileHostMounts([{ host: 'x.*', path: '/apis' }])[0].path).toBe(
      '/apis',
    )
  })
})

describe('checkHostMounts', () => {
  test('passes no mounts and good ones, and throws on a bad one', () => {
    expect(() => checkHostMounts({ hostMounts: [] })).not.toThrow()
    expect(() =>
      checkHostMounts({ hostMounts: [{ host: 'kit.*', path: '/kit' }] }),
    ).not.toThrow()
    expect(() =>
      checkHostMounts({ hostMounts: [{ host: 'kit.*', path: 'kit' }] }),
    ).toThrow('hostMounts[0].path')
  })
})

describe('mountedPath', () => {
  test('the host root is the mount itself, and every other path is under it', () => {
    expect(mountedPath('/', '/kit')).toBe('/kit')
    expect(mountedPath('/forms', '/kit')).toBe('/kit/forms')
    expect(mountedPath('/forms/date/', '/kit')).toBe('/kit/forms/date/')
  })
})
