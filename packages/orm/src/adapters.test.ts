import { afterAll, describe, expect, test } from 'bun:test'
import {
  createDbAdapter,
  getAdapter,
  listAdapters,
  registerAdapter,
  resolveDriver,
} from './adapters'
import type { Driver, SQLAdapter } from './adapters'

/**
 * The extension point, exercised the way a third-party package would use it.
 *
 * Without this the tests below do not compile — `registerAdapter({driver:
 * 'mssql'})` is a type error, because `Driver` is `keyof DriverRegistry` and
 * nothing had declared `mssql`. That is the design working: a driver name is
 * checked, and adding one is a declaration rather than a string.
 *
 * `'./adapters'` is the *barrel*, which is `'@bakery/orm/adapters'` from
 * outside — and it merges even though `DriverRegistry` is declared a file
 * deeper, behind an `export *`. That is worth stating because the alternative
 * is silent: an augmentation aimed at a module the consumer cannot resolve
 * declares a second, unrelated interface and every driver name goes on being
 * rejected with no clue as to why. Both directions are asserted — `oracle`,
 * which nothing declares, is still a type error here.
 */
declare module './adapters' {
  interface DriverRegistry {
    mssql: true
    pgbouncer: true
  }
}

/**
 * Adapter resolution, and the registry that a third-party adapter plugs into.
 *
 * The table below is the *previous* `getDriver` switch, transcribed case by
 * case, because the registry had to be a refactor and not a rewrite: `DB_URL`
 * is set once in someone's environment and a driver that quietly changes is a
 * production incident, not a failed test.
 */
describe('driver resolution', () => {
  const CASES: [string, Driver][] = [
    ['', 'sqlite'],
    [':memory:', 'sqlite'],
    ['sqlite://./app.db', 'sqlite'],
    ['sqlite:app.db', 'sqlite'],
    ['file:///tmp/app.db', 'sqlite'],
    ['./bakery/server.db', 'sqlite'],
    ['C:\\data\\server.db', 'sqlite'],
    ['app.db', 'sqlite'],
    ['mysql://root@127.0.0.1:3306/app', 'mysql'],
    ['mysqls://root@127.0.0.1:3306/app', 'mysql'],
    ['mysqli://root@127.0.0.1:3306/app', 'mysql'],
    ['MYSQL://root@127.0.0.1:3306/app', 'mysql'],
    ['postgres://postgres@127.0.0.1:5432/app', 'postgres'],
    ['postgresql://postgres@127.0.0.1:5432/app', 'postgres'],
    // No scheme, no path separator: the "looks like a host" fallback.
    ['db.internal:5432', 'postgres'],
  ]

  for (const [target, driver] of CASES) {
    test(`${target || '(empty)'} -> ${driver}`, () => {
      expect({ target, driver: resolveDriver(target) }).toEqual({ target, driver })
    })
  }

  test('mysqlis:// now reaches MySQL, which is a fix', () => {
    // The old factory matched /^mysql[is]?:\/\//  — one optional character — so
    // `mysqlis://` fell through to the path heuristic and opened as *SQLite*.
    // MySQLAdapter's own constructor has always rewritten all four spellings,
    // so the two disagreed and the URL never reached the adapter that
    // understood it.
    expect(resolveDriver('mysqlis://root@127.0.0.1:3306/app')).toBe('mysql')
  })

  test('an unregistered scheme still falls to the path heuristic', () => {
    // Unchanged, and worth pinning: `isSQLite` claims anything with a slash.
    expect(resolveDriver('mssql://sa@localhost/app')).toBe('sqlite')
  })
})

describe('registerAdapter', () => {
  const stub = { driver: 'stub' } as unknown as SQLAdapter

  // The registry is process-global — the same hazard as `mock.module`, and the
  // reason every test here uses its disposer. This is the check that they did:
  // a stub left registered would be handed to every later file's `initDB()`.
  const builtIns = Object.fromEntries(
    listAdapters().map(s => [s.driver, s] as const),
  )
  afterAll(() => {
    expect(
      Object.fromEntries(listAdapters().map(s => [s.driver, s] as const)),
    ).toEqual(builtIns)
  })

  test('a scheme is claimed by whoever declared it', () => {
    const off = registerAdapter({
      driver: 'mssql',
      protocols: ['mssql', 'sqlserver'],
      open: () => stub,
    })
    expect(resolveDriver('mssql://sa@localhost/app')).toBe('mssql')
    expect(resolveDriver('sqlserver://sa@localhost/app')).toBe('mssql')
    off()
    // …and gone again: the previous answer comes back.
    expect(resolveDriver('mssql://sa@localhost/app')).toBe('sqlite')
  })

  test('a scheme is checked before any matches() heuristic', () => {
    // The ordering that makes the registry usable at all. `isSQLite` returns
    // true for every one of these targets, and it is registered first.
    const off = registerAdapter({
      driver: 'mssql',
      protocols: ['mssql'],
      open: () => stub,
    })
    expect(resolveDriver('mssql://sa@localhost/app')).toBe('mssql')
    off()
  })

  test('a later registration can take a built-in scheme', () => {
    const off = registerAdapter({
      driver: 'pgbouncer',
      protocols: ['postgres'],
      open: () => stub,
    })
    expect(resolveDriver('postgres://x@h/db')).toBe('pgbouncer')
    off()
    expect(resolveDriver('postgres://x@h/db')).toBe('postgres')
  })

  test('an override hides the built-in without displacing it', () => {
    const before = getAdapter('sqlite')
    const off = registerAdapter({
      driver: 'sqlite',
      protocols: ['sqlite'],
      open: () => stub,
    })
    expect(getAdapter('sqlite')).not.toBe(before)
    // One entry per driver, however many are stacked under it — otherwise the
    // reverse scan in resolveDriver would ask the same adapter twice.
    expect(listAdapters().filter(s => s.driver === 'sqlite')).toHaveLength(1)
    off()
    expect(getAdapter('sqlite')).toBe(before)
  })

  test('a stale disposer does not remove someone else’s adapter', () => {
    // Two registrations under one name. Without the identity check in the
    // disposer, releasing the outer one would delete the *inner* adapter and
    // leave the driver unregistered — `createDbAdapter` would then throw for a
    // driver that is plainly still registered.
    const builtIn = getAdapter('sqlite')
    const inner = { driver: 'sqlite', open: () => stub } as const
    const off1 = registerAdapter({ driver: 'sqlite', open: () => stub })
    const off2 = registerAdapter(inner)
    off1() // released first, though it was registered first
    expect(getAdapter('sqlite')).toBe(inner)
    off2()
    expect(getAdapter('sqlite')).toBe(builtIn)
  })

  test('createDbAdapter opens through the registry', async () => {
    let openedWith: unknown
    const off = registerAdapter({
      driver: 'sqlite',
      protocols: ['sqlite'],
      matches: () => true,
      open(target) {
        openedWith = target
        return stub
      },
    })
    const previous = process.env.DB_URL
    process.env.DB_URL = 'sqlite://:memory:'
    try {
      expect(await createDbAdapter()).toBe(stub)
      expect(openedWith).toBe('sqlite://:memory:')
    } finally {
      if (previous === undefined) delete process.env.DB_URL
      else process.env.DB_URL = previous
      off()
    }
  })
})
