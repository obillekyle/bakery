import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Bakery } from '../../core/bakery'
import { __resetTestConfig, __setTestConfig, initConfig } from '../../core/config'
import { fs } from '../../utils'
import { RouteData, type Route } from './$base'
import { DynamicHandler } from './$dynamic'

const ROUTE_DIR = fs.resolve(process.cwd(), '.cache/__dynamic-test__')
const ECHO = `${ROUTE_DIR}/echo.ts` as fs.AbsolutePath
const BROKEN = `${ROUTE_DIR}/broken.ts` as fs.AbsolutePath
const NO_DEFAULT = `${ROUTE_DIR}/no-default.ts` as fs.AbsolutePath

/** Stands in for the Bun.serve instance, so identity is checkable. */
const SERVER_STUB = { __tag: 'test-server' } as any

let previousServer: any

beforeAll(async () => {
  await initConfig()
  await Bun.write(
    ECHO,
    `export default (...args: any[]) => ({
  argc: args.length,
  serverTag: args[2]?.__tag ?? null,
})
`,
  )
  // Written here, not inside the tests that use them: Bun's module resolver
  // does not see files added to a directory it has already resolved from.
  await Bun.write(BROKEN, 'export default function ( {\n')
  await Bun.write(NO_DEFAULT, 'export const x = 1\n')
  previousServer = Bakery.server
  Bakery.server = SERVER_STUB
})

afterAll(async () => {
  Bakery.server = previousServer
  await rm(ROUTE_DIR, { recursive: true, force: true })
})

describe('DynamicHandler.executeModule', () => {
  test('passes the server as the third argument ApiCallback declares', async () => {
    // ApiCallback is `(req, body, server)` and this is its only call site; it
    // used to pass two arguments, so `server` was always undefined for every
    // route that was not wrapped in html().
    const result = await DynamicHandler.executeModule(
      ECHO,
      new Request('http://localhost/echo'),
      { a: 1 },
    )

    expect(result.argc).toBe(3)
    expect(result.serverTag).toBe('test-server')
  })

  test('a module that fails to import rejects instead of resolving null', async () => {
    // A syntax error in a route module must not be indistinguishable from a
    // missing route: null means 404 to every caller, so the failure has to
    // propagate as a throw and reach the error registry as a 500.
    expect(
      DynamicHandler.executeModule(
        BROKEN,
        new Request('http://localhost/broken'),
        {},
      ),
    ).rejects.toThrow()
  })

  test('a module with no default export still resolves null (a 404, not a 500)', async () => {
    expect(
      await DynamicHandler.executeModule(
        NO_DEFAULT,
        new Request('http://localhost/no-default'),
        {},
      ),
    ).toBeNull()
  })
})

/**
 * `findDynamicRoute` scans every cached dynamic route and applies four filters:
 * the regex has to match, the file has to still exist, it has to sit under the
 * serve root, and it must not be behind a `.forbidden` marker.
 *
 * Three of those are filesystem work and one is a regex test, so the order they
 * run in is a performance decision — but only if a rejected entry never shadows
 * a later one. These pin that: in each case the *first* entry in the cache
 * matches the path and is rejected, and the answer must still be the second.
 */
describe('DynamicHandler.findDynamicRoute', () => {
  const SCAN_DIR = `${ROUTE_DIR}/scan` as fs.AbsolutePath
  const LIVE = `${SCAN_DIR}/live/[id].ts` as fs.AbsolutePath
  const GONE = `${SCAN_DIR}/gone/[id].ts` as fs.AbsolutePath
  const HIDDEN = `${SCAN_DIR}/hidden/[id].ts` as fs.AbsolutePath

  class ScanHandler extends DynamicHandler {}

  function info(filePath: fs.AbsolutePath): Route.Info {
    // Same `path` for every entry, so every regex matches `/item/1`.
    return new RouteData.Info(filePath, 'item/[id].ts')
  }

  function seed(...entries: Route.Info[]) {
    ScanHandler.dynamicCache.clear()
    for (const entry of entries) ScanHandler.dynamicCache.set(entry.regex!, entry)
  }

  beforeAll(async () => {
    await Bun.write(LIVE, 'export default () => 1\n')
    await Bun.write(HIDDEN, 'export default () => 1\n')
    await Bun.write(`${SCAN_DIR}/hidden/.forbidden`, '')
    __setTestConfig({ root: SCAN_DIR })
  })

  afterAll(() => {
    __resetTestConfig()
    ScanHandler.dynamicCache.clear()
  })

  test('a matching entry whose file is gone does not shadow a live one', () => {
    seed(info(GONE), info(LIVE))
    expect(ScanHandler.findDynamicRoute('/item/1')?.filePath).toBe(LIVE)
  })

  test('a matching entry outside the serve root does not shadow a live one', () => {
    seed(info(`${ROUTE_DIR}/outside/[id].ts` as fs.AbsolutePath), info(LIVE))
    expect(ScanHandler.findDynamicRoute('/item/1')?.filePath).toBe(LIVE)
  })

  test('a matching entry behind .forbidden does not shadow a live one', () => {
    seed(info(HIDDEN), info(LIVE))
    expect(ScanHandler.findDynamicRoute('/item/1')?.filePath).toBe(LIVE)
  })

  test('a non-matching path finds nothing', () => {
    seed(info(LIVE))
    expect(ScanHandler.findDynamicRoute('/other/1/2')).toBeNull()
  })

  test('resolveRoute returns the dynamic match', async () => {
    seed(info(LIVE))
    expect((await ScanHandler.resolveRoute('/item/1'))?.filePath).toBe(LIVE)
  })

  test('resolveRoute rejects a dynamic entry whose file is gone', async () => {
    // The validity of a dynamic hit is established inside `findDynamicRoute`;
    // this pins that it is still established, wherever the check lives.
    seed(info(GONE))
    expect(await ScanHandler.resolveRoute('/item/1')).toBeNull()
  })

  test('resolveRoute rejects a dynamic entry behind .forbidden', async () => {
    seed(info(HIDDEN))
    expect(await ScanHandler.resolveRoute('/item/1')).toBeNull()
  })

  test('canHandle agrees with resolveRoute for every cache state', async () => {
    // `canHandle` may answer from a cache — it already does for `this.cache` —
    // so what has to hold is that it never disagrees with what `resolveRoute`
    // is about to decide, in either direction.
    for (const [label, seeded] of [
      ['live', LIVE],
      ['gone', GONE],
      ['hidden', HIDDEN],
    ] as const) {
      seed(info(seeded))
      const resolved = await ScanHandler.resolveRoute('/item/1')
      expect(`${label}:${await ScanHandler.canHandle('/item/1')}`).toBe(
        `${label}:${Boolean(resolved)}`,
      )
    }

    seed(info(LIVE))
    expect(await ScanHandler.canHandle('/other/1/2')).toBe(false)
    // A literal `[id]` in the URL is never a route, cache or no cache.
    expect(await ScanHandler.canHandle('/item/[id]')).toBe(false)
  })
})

describe('findDynamicRoute — catch-all ordering', () => {
  // Isolated per-class caches: the dynamicCache registry is keyed by class
  // identity, so a subclass never pollutes TSXHandler/ApiHandler state.
  class OrderingHandler extends DynamicHandler {}

  const CA_ROOT = fs.resolve(ROUTE_DIR, 'ordering')
  const files = {
    id: `${CA_ROOT}/docs/[id].tsx`,
    catchAll: `${CA_ROOT}/docs/[...slug].tsx`,
    deepCatchAll: `${CA_ROOT}/docs/guides/[...rest].tsx`,
    missing: `${CA_ROOT}/gone/[...nope].tsx`,
  }

  beforeAll(async () => {
    for (const f of [files.id, files.catchAll, files.deepCatchAll]) {
      await Bun.write(f, 'export default () => null\n')
    }
    __setTestConfig({ root: CA_ROOT } as any)
  })

  afterAll(() => {
    __resetTestConfig()
    OrderingHandler.dynamicCache.clear()
  })

  const infoFor = (abs: string) =>
    new RouteData.Info(abs as fs.AbsolutePath, fs.relative(CA_ROOT, abs))

  test('a single-param route beats a catch-all even when the catch-all was cached first', () => {
    OrderingHandler.dynamicCache.clear()
    const ca = infoFor(files.catchAll)
    const id = infoFor(files.id)
    // Insertion order deliberately favors the catch-all; specificity must win.
    OrderingHandler.dynamicCache.set(ca.regex!, ca)
    OrderingHandler.dynamicCache.set(id.regex!, id)

    const hit = OrderingHandler.findDynamicRoute('/docs/42')
    expect(hit).not.toBeNull()
    expect(hit!.path).toBe(fs.relative(CA_ROOT, files.id))
  })

  test('among catch-alls, the longer prefix wins', () => {
    OrderingHandler.dynamicCache.clear()
    const shallow = infoFor(files.catchAll)
    const deep = infoFor(files.deepCatchAll)
    OrderingHandler.dynamicCache.set(shallow.regex!, shallow)
    OrderingHandler.dynamicCache.set(deep.regex!, deep)

    const hit = OrderingHandler.findDynamicRoute('/docs/guides/routing')
    expect(hit!.path).toBe(fs.relative(CA_ROOT, files.deepCatchAll))

    // Outside the deep prefix the shallow one still answers.
    const shallowHit = OrderingHandler.findDynamicRoute('/docs/other')
    expect(shallowHit!.path).toBe(fs.relative(CA_ROOT, files.catchAll))
  })

  test('a catch-all still answers when it is the only match, and a deleted one never does', () => {
    OrderingHandler.dynamicCache.clear()
    const ca = infoFor(files.catchAll)
    const gone = infoFor(files.missing) // never written to disk
    OrderingHandler.dynamicCache.set(gone.regex!, gone)
    OrderingHandler.dynamicCache.set(ca.regex!, ca)

    expect(OrderingHandler.findDynamicRoute('/gone/x/y')).toBeNull()
    const hit = OrderingHandler.findDynamicRoute('/docs/a/b/c')
    expect(hit!.path).toBe(fs.relative(CA_ROOT, files.catchAll))
    expect(hit!.getParams('/docs/a/b/c')).toEqual({ slug: 'a/b/c' })
  })
})

describe('findDynamicRoute — catch-alls yield to real files', () => {
  class YieldHandler extends DynamicHandler {}
  const Y_ROOT = fs.resolve(ROUTE_DIR, 'yield')

  beforeAll(async () => {
    await Bun.write(`${Y_ROOT}/site/[...rest].tsx`, 'export default () => null\n')
    await Bun.write(`${Y_ROOT}/site/app.css`, 'body{}\n')
    __setTestConfig({ root: Y_ROOT } as any)
    const info = new RouteData.Info(
      `${Y_ROOT}/site/[...rest].tsx` as fs.AbsolutePath,
      'site/[...rest].tsx',
    )
    YieldHandler.dynamicCache.set(info.regex!, info)
  })

  afterAll(() => {
    __resetTestConfig()
    YieldHandler.dynamicCache.clear()
  })

  test('a cached catch-all declines when the request names a real file', () => {
    expect(YieldHandler.findDynamicRoute('/site/app.css')).toBeNull()
  })

  test('and still answers when it does not', () => {
    const hit = YieldHandler.findDynamicRoute('/site/some/page')
    expect(hit).not.toBeNull()
    expect(hit!.getParams('/site/some/page')).toEqual({ rest: 'some/page' })
  })
})
