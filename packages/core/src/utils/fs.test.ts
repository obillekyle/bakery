import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { type HostContext, hostStore } from '../core/context'
import { Try } from './common'
import { fs } from './fs'

/**
 * The implementation `isForbidden` had before its walk was rewritten to use
 * string edits instead of two `node:path` `resolve` calls per level.
 *
 * Kept verbatim as an oracle rather than as a set of hand-written expectations:
 * the rewrite's whole claim is "same answer, fewer syscalls", and the way that
 * claim breaks is a path shape nobody thought to write a case for — a drive
 * root, a POSIX root, a directory whose name is a prefix of its sibling's.
 * Comparing against the original over a corpus tests the claim directly.
 */
function referenceIsForbidden(pathToCheck: string, root: string): boolean {
  const safeResolve = (...paths: string[]) =>
    resolve(...paths).replace(/\\/g, '/')
  if (!pathToCheck || !root) return false
  let curr = safeResolve(pathToCheck)
  const normalizedRoot = safeResolve(root)

  while (
    curr.startsWith(normalizedRoot) &&
    curr.length >= normalizedRoot.length
  ) {
    if (existsSync(safeResolve(curr, '.forbidden'))) return true
    const parent = safeResolve(curr, '..')
    if (parent === curr) break
    curr = parent
  }
  return false
}

describe('fs.isForbidden', () => {
  const base = fs.resolve(
    import.meta.dir,
    '__fixtures__',
    'forbidden-equivalence',
  )

  const dirs = [
    'a',
    'a/b',
    'a/b/c',
    'a/b/c/d',
    'pub',
    'pub/secret',
    'pub/secret/deep',
    'pub/open',
    // `ab` is a string prefix of `abc`: the walk's containment test is a
    // `startsWith`, so a sibling whose name extends another's is the case
    // that catches an off-by-one in the parent step.
    'ab',
    'abc',
    'dots.dir',
    'dots.dir/sub',
    'with space',
    'with space/nested',
  ]

  beforeAll(async () => {
    for (const dir of dirs) await fs.mkdir(fs.resolve(base, dir))
    await Bun.write(fs.resolve(base, 'a/b/.forbidden'), '')
    await Bun.write(fs.resolve(base, 'pub/secret/.forbidden'), '')
    await Bun.write(fs.resolve(base, 'a/b/c/file.html'), 'x')
    await Bun.write(fs.resolve(base, 'pub/open/ok.html'), 'x')
    await Bun.write(fs.resolve(base, 'with space/nested/page.html'), 'x')
  })

  afterAll(async () => {
    await fs.rm(fs.resolve(import.meta.dir, '__fixtures__'), {
      recursive: true,
      force: true,
    })
  })

  test('marks a directory holding .forbidden, and everything under it', () => {
    expect(fs.isForbidden(fs.resolve(base, 'a/b'), base)).toBe(true)
    expect(fs.isForbidden(fs.resolve(base, 'a/b/c'), base)).toBe(true)
    expect(fs.isForbidden(fs.resolve(base, 'a/b/c/d'), base)).toBe(true)
    expect(fs.isForbidden(fs.resolve(base, 'a/b/c/file.html'), base)).toBe(true)
    expect(fs.isForbidden(fs.resolve(base, 'pub/secret/deep'), base)).toBe(true)
  })

  test('leaves siblings and parents of a forbidden directory alone', () => {
    expect(fs.isForbidden(fs.resolve(base, 'a'), base)).toBe(false)
    expect(fs.isForbidden(fs.resolve(base, 'pub'), base)).toBe(false)
    expect(fs.isForbidden(fs.resolve(base, 'pub/open/ok.html'), base)).toBe(
      false,
    )
    expect(fs.isForbidden(fs.resolve(base, 'ab'), base)).toBe(false)
    expect(fs.isForbidden(fs.resolve(base, 'abc'), base)).toBe(false)
  })

  test('walks up only as far as the root it was given', () => {
    // `a/b` is forbidden, so a root *below* it must not see the marker above.
    expect(
      fs.isForbidden(fs.resolve(base, 'a/b/c/d'), fs.resolve(base, 'a/b/c')),
    ).toBe(false)
    // ...but from `a` the marker is between the target and the root.
    expect(
      fs.isForbidden(fs.resolve(base, 'a/b/c/d'), fs.resolve(base, 'a')),
    ).toBe(true)
  })

  test('visits every level between target and root, and no others', async () => {
    // End-to-end booleans hide a parent step that skips or mangles a level:
    // with no marker anywhere the answer is `false` either way. So place a
    // single marker at each level in turn and require the answer to flip
    // exactly for the levels that lie between the target and the root.
    const target = fs.resolve(base, 'a/b/c/d')
    const root = fs.resolve(base, 'a')

    const shouldSee = ['a', 'a/b', 'a/b/c', 'a/b/c/d']
    const shouldNotSee = ['', 'pub', 'pub/open']

    // `a/b/.forbidden` is part of the shared fixture and would mask every
    // result here, so it is lifted for the duration of this test.
    const shared = fs.resolve(base, 'a/b/.forbidden')
    await fs.rm(shared, { force: true })

    try {
      for (const level of [...shouldSee, ...shouldNotSee]) {
        const marker = fs.resolve(base, level, '.forbidden')
        await Bun.write(marker, '')
        const seen = fs.isForbidden(target, root)
        await fs.rm(marker, { force: true })

        expect({ level, seen }).toEqual({
          level,
          seen: shouldSee.includes(level),
        })
      }
    } finally {
      await Bun.write(shared, '')
    }
  })

  test('collapses dot segments before walking', () => {
    // Reaches `a/b` by traversal; the marker must still be found.
    expect(fs.isForbidden(fs.resolve(base, 'pub/../a/b/c'), base)).toBe(true)
    expect(fs.isForbidden(`${base}/a/b/../../pub/open/ok.html`, base)).toBe(
      false,
    )
  })

  test('a .forbidden created after a negative answer takes effect at once', async () => {
    // This is the anti-memoisation guard. Negative results are deliberately
    // not cached: production has no invalidator (the SIGHUP handler installed
    // in `core/init.ts` is a no-op), so a cached "not forbidden" would keep
    // serving a file an operator had just marked. If someone adds a cache
    // here, this test is what should stop them.
    const late = fs.resolve(base, 'pub/open')
    expect(fs.isForbidden(late, base)).toBe(false)

    await Bun.write(fs.resolve(late, '.forbidden'), '')
    try {
      expect(fs.isForbidden(late, base)).toBe(true)
      expect(fs.isForbidden(fs.resolve(late, 'ok.html'), base)).toBe(true)
    } finally {
      await fs.rm(fs.resolve(late, '.forbidden'), { force: true })
    }

    expect(fs.isForbidden(late, base)).toBe(false)
  })

  test('agrees with the pre-rewrite implementation across path shapes', () => {
    const roots = [
      base,
      `${base}/`,
      fs.resolve(base, 'a'),
      fs.resolve(base, 'pub'),
      fs.resolve(base, 'pub/secret'),
      fs.resolve(base, 'missing'),
      'C:/',
      '/',
      '',
    ]
    const targets = [
      base,
      fs.resolve(base, 'a'),
      fs.resolve(base, 'a/b'),
      fs.resolve(base, 'a/b/c/d'),
      fs.resolve(base, 'a/b/c/file.html'),
      fs.resolve(base, 'pub/open/ok.html'),
      fs.resolve(base, 'pub/secret/deep'),
      fs.resolve(base, 'with space/nested/page.html'),
      fs.resolve(base, 'dots.dir/sub'),
      fs.resolve(base, 'ab'),
      fs.resolve(base, 'abc'),
      `${base}/missing/thing.html`,
      `${base}//a//b`,
      `${base}/./a/./b`,
      `${base}/a/../a/b/c`,
      // Percent-encoded traversal stays literal: URL parsing does not decode
      // it, and neither does the walk.
      `${base}/%2e%2e/etc`,
      'C:/',
      '/',
      '',
    ]

    let compared = 0
    for (const root of roots) {
      for (const target of targets) {
        expect({
          root,
          target,
          forbidden: fs.isForbidden(target, root),
        }).toEqual({
          root,
          target,
          forbidden: referenceIsForbidden(target, root),
        })
        compared++
      }
    }
    expect(compared).toBe(roots.length * targets.length)
  })
})

/**
 * The per-request dedup: `isForbidden` runs 4-6x per request over overlapping
 * subtrees (router, getStatic, every level of getRoute, the dynamic-route
 * cache), and each `existsSync` miss costs ~50us on Bun/Windows. Raw probe
 * results are memoised on the current `hostStore` value — created per request
 * in worker.ts, dead when the request is — which is a different thing from the
 * cross-request cache the regression test above ('a .forbidden created after a
 * negative answer takes effect at once') forbids. That test runs with no store
 * and must stay green untouched.
 */
describe('fs.isForbidden — per-request probe dedup', () => {
  const base = fs.resolve(import.meta.dir, '__fixtures__', 'forbidden-dedup')
  const requestStore = (): HostContext => ({
    config: {} as any,
    hostname: 'dedup-test',
  })

  /** Counting seam: every probe is still answered by the real filesystem. */
  function countProbes(): Map<string, number> {
    const counts = new Map<string, number>()
    fs.__setForbiddenProbe(probe => {
      counts.set(probe, (counts.get(probe) || 0) + 1)
      return existsSync(probe)
    })
    return counts
  }

  beforeAll(async () => {
    await fs.mkdir(fs.resolve(base, 'a/b/c'))
    await fs.mkdir(fs.resolve(base, 'm/sub'))
    await Bun.write(fs.resolve(base, 'a/b/c/page.html'), 'x')
    await Bun.write(fs.resolve(base, 'm/.forbidden'), '')
  })

  afterAll(async () => {
    fs.__resetForbiddenProbe()
    await fs.rm(base, { recursive: true, force: true })
  })

  test('overlapping walks in one request probe each level exactly once', async () => {
    const target = fs.resolve(base, 'a/b/c/page.html')
    const counts = countProbes()

    try {
      await hostStore.run(requestStore(), async () => {
        expect(fs.isForbidden(target, base)).toBe(false) // router, up front
        expect(fs.isForbidden(target, base)).toBe(false) // getStatic re-check
        expect(fs.isForbidden(fs.resolve(base, 'a/b'), base)).toBe(false) // getRoute level
        expect(fs.isForbidden(fs.resolve(base, 'a'), base)).toBe(false) // deeper recursion
      })
    } finally {
      fs.__resetForbiddenProbe()
    }

    // Five distinct levels between target and root — page.html, c, b, a and
    // the root itself — and not one of them probed twice.
    expect(counts.size).toBe(5)
    for (const [probe, count] of counts) {
      expect({ probe, count }).toEqual({ probe, count: 1 })
    }
  })

  test('without a store, every walk probes for itself (unchanged behavior)', () => {
    const target = fs.resolve(base, 'a/b/c/page.html')
    const counts = countProbes()

    try {
      expect(fs.isForbidden(target, base)).toBe(false)
      expect(fs.isForbidden(target, base)).toBe(false)
    } finally {
      fs.__resetForbiddenProbe()
    }

    expect(counts.size).toBe(5)
    for (const [probe, count] of counts) {
      expect({ probe, count }).toEqual({ probe, count: 2 })
    }
  })

  test('a marker found once denies every later walk in the same request', async () => {
    const counts = countProbes()

    try {
      await hostStore.run(requestStore(), async () => {
        expect(fs.isForbidden(fs.resolve(base, 'm/sub'), base)).toBe(true)
        expect(fs.isForbidden(fs.resolve(base, 'm/sub'), base)).toBe(true)
        expect(fs.isForbidden(fs.resolve(base, 'm'), base)).toBe(true)
      })
    } finally {
      fs.__resetForbiddenProbe()
    }

    // m/sub and m each probed once; the two later walks answered from the map.
    expect(counts.get(`${fs.resolve(base, 'm')}/.forbidden`)).toBe(1)
    expect(counts.get(`${fs.resolve(base, 'm/sub')}/.forbidden`)).toBe(1)
  })

  test('the memo holds probes, not verdicts — roots stay independent', async () => {
    const sub = fs.resolve(base, 'm/sub')

    // Warm the map with a walk that finds the marker above `m/sub`, then ask
    // again with a root *below* the marker. A verdict cache would leak `true`
    // into the second answer; a probe cache cannot.
    await hostStore.run(requestStore(), async () => {
      expect(fs.isForbidden(sub, base)).toBe(true)
      expect(fs.isForbidden(sub, sub)).toBe(false)
    })

    // And in the order that breaks a "clean up to root" shortcut: the first
    // walk records an honest `false` probe at `m/sub`, and the second must
    // still climb past it to the marker rather than short-circuit on it.
    await hostStore.run(requestStore(), async () => {
      expect(fs.isForbidden(sub, sub)).toBe(false)
      expect(fs.isForbidden(sub, base)).toBe(true)
    })
  })

  test('a marker dropped mid-request lands on the next request, never later', async () => {
    const lateDir = fs.resolve(base, 'a/b')
    const marker = fs.resolve(lateDir, '.forbidden')

    try {
      await hostStore.run(requestStore(), async () => {
        expect(fs.isForbidden(lateDir, base)).toBe(false)
        await Bun.write(marker, '')
        // Same request: the negative probe is already recorded, and a marker
        // dropped mid-request has no semantics to honour — the operator's
        // guarantee is "the next request sees it".
        expect(fs.isForbidden(lateDir, base)).toBe(false)
      })

      // A fresh request store sees it immediately...
      await hostStore.run(requestStore(), async () => {
        expect(fs.isForbidden(lateDir, base)).toBe(true)
      })
      // ...and so does a storeless caller.
      expect(fs.isForbidden(lateDir, base)).toBe(true)
    } finally {
      await fs.rm(marker, { force: true })
    }
  })
})

describe('fs.getOrCreateCachedFile', () => {
  const dir = fs.resolve(import.meta.dir, '__fixtures__', 'cached-file')

  afterAll(async () => {
    await fs.rm(fs.resolve(import.meta.dir, '__fixtures__'), {
      recursive: true,
      force: true,
    })
  })

  test('N concurrent first-hits compile once, not N times', async () => {
    // The cache-validity check is a filesystem test, so without a record of
    // work in progress every caller in a burst sees "not cached" and compiles.
    // This is the whole point of the guard: 8 callers, 1 compile.
    let compiles = 0

    const compiler = async () => {
      compiles++
      // Yield long enough that all eight callers have arrived before the first
      // build finishes. Without it the test could pass on scheduling luck.
      await Bun.sleep(25)
      return 'export const value = 1'
    }

    const files = await Promise.all(
      Array.from({ length: 8 }, () =>
        fs.getOrCreateCachedFile(dir, 'burst.js', null, compiler),
      ),
    )

    expect(compiles).toBe(1)
    expect(files.filter(Boolean).length).toBe(8)
    // One shared build means one shared result, not eight separate writes.
    expect(new Set(files.map(file => file?.name)).size).toBe(1)
    expect(await Bun.file(fs.resolve(dir, 'burst.js')).text()).toBe(
      'export const value = 1',
    )
  })

  test('a later caller is served from disk rather than joining a stale entry', async () => {
    // The dedup map must not outlive its build: an entry that stayed would
    // turn the first result into a permanent answer for that path.
    let compiles = 0
    const compiler = () => {
      compiles++
      return 'first'
    }

    await fs.getOrCreateCachedFile(dir, 'sequential.js', null, compiler)
    await fs.getOrCreateCachedFile(dir, 'sequential.js', null, compiler)

    expect(compiles).toBe(1)

    // ...and a newer source still rebuilds, so the guard did not swallow the
    // mtime check it wraps.
    await fs.getOrCreateCachedFile(
      dir,
      'sequential.js',
      Date.now() + 60_000,
      () => {
        compiles++
        return 'second'
      },
    )

    expect(compiles).toBe(2)
    expect(await Bun.file(fs.resolve(dir, 'sequential.js')).text()).toBe(
      'second',
    )
  })

  test('a failed build is retried rather than remembered', async () => {
    let attempts = 0
    const failing = () => {
      attempts++
      throw new Error('compile exploded')
    }

    for (let i = 0; i < 2; i++) {
      const [error] = await Try.catch(
        fs.getOrCreateCachedFile(dir, 'failing.js', null, failing),
      )
      expect(error?.message).toBe('compile exploded')
    }

    expect(attempts).toBe(2)
  })

  test('different paths still build concurrently', async () => {
    // Serialising every build behind one lock would fix the duplication and
    // cost the parallelism; the key has to be per-path.
    let peak = 0
    let active = 0

    const compiler = async () => {
      active++
      peak = Math.max(peak, active)
      await Bun.sleep(20)
      active--
      return 'x'
    }

    await Promise.all(
      ['a.js', 'b.js', 'c.js'].map(name =>
        fs.getOrCreateCachedFile(dir, name, null, compiler),
      ),
    )

    expect(peak).toBe(3)
  })

  // The build's compression moved off-thread for payloads at or above
  // ASYNC_COMPRESSION_MIN (32KB). Both branches must still land the same
  // trio: raw + .zst + .gz, all decompressing to the compiler's output.
  function trioContent(size: number): string {
    let out = ''
    let i = 0
    while (out.length < size) {
      out += `export const v${i} = ${JSON.stringify({ id: i++, k: 'value' })}\n`
    }
    return out.slice(0, size)
  }

  async function expectTrio(name: string, content: string) {
    const file = await fs.getOrCreateCachedFile(dir, name, null, () => content)

    // The compressed branch answers with the first COMPRESSION_MAP variant.
    expect(file?.name?.endsWith('.zst')).toBe(true)

    const rawPath = fs.resolve(dir, name)
    expect(await Bun.file(rawPath).text()).toBe(content)

    const zst = await Bun.file(`${rawPath}.zst`).arrayBuffer()
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(zst))).toBe(content)

    const gz = await Bun.file(`${rawPath}.gz`).arrayBuffer()
    expect(new TextDecoder().decode(Bun.gunzipSync(gz))).toBe(content)
  }

  test('trio round-trips for an offload-sized (async-compressed) build', async () => {
    await expectTrio('trio-large.js', trioContent(96 * 1024))
  })

  test('trio round-trips for a small (sync-compressed) build', async () => {
    await expectTrio('trio-small.js', trioContent(4 * 1024))
  })
})
