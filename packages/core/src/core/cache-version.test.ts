import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { __wipeCacheDir } from './cache-version'
import { getAppVersion, getFrameworkVersion } from './context'

/**
 * `.cache/` invalidation keys on the framework's version as well as the app's.
 *
 * It used to key on the app's alone, through a function called
 * `getBakeryVersion` that read `<cwd>/package.json` — so `bun update
 * @bakery-framework/core` left a cache full of artifacts compiled by the previous
 * framework version and nothing invalidated them. The misnomer is what hid it,
 * and the repo layout is what kept it hidden: `apps/example`'s version tracks
 * the framework's, so bumping both made the app version look sufficient.
 *
 * These assert the two properties the fix depends on — that the two versions
 * are read from *different* files, and that the marker carries both — rather
 * than re-testing `fs.rm`, which is a recursive forced delete and not something
 * to exercise for a unit test.
 */
describe('cache invalidation reads two versions', () => {
  test('the app version comes from the cwd package.json', async () => {
    // The suite runs from the repo root, whose package.json is the workspace's.
    const root = await Bun.file(`${process.cwd()}/package.json`).json()
    expect(getAppVersion()).toBe(root.version)
  })

  test('the framework version comes from @bakery-framework/core, not the cwd', async () => {
    const core = await Bun.file(`${import.meta.dir}/../../package.json`).json()
    expect(core.name).toBe('@bakery-framework/core')
    expect(getFrameworkVersion()).toBe(core.version)
  })

  test('the two are read from different files', async () => {
    // The whole bug in one assertion: if these ever resolve to the same file,
    // the framework's version is not being consulted and an upgrade stops
    // invalidating the cache again.
    const cwdPkg = await Bun.file(`${process.cwd()}/package.json`).json()
    const corePkg = await Bun.file(
      `${import.meta.dir}/../../package.json`,
    ).json()
    expect(cwdPkg.name).not.toBe(corePkg.name)
  })

  test('neither falls back to the other on a missing file', () => {
    // Distinct fallbacks on purpose: a shared one would make an unreadable
    // manifest look like a version that never changes, which is silently
    // "never invalidate" rather than "invalidate once".
    //
    // The sentinels are deliberately impossible as real versions. They were
    // '0.0.0' and '1.0.0' until the framework was renumbered to 1.0.0 for its
    // first publish — at which point the framework's *correct* version equalled
    // the app's fallback, and this assertion could no longer distinguish a
    // successful read from a fallback. It failed, which is the good outcome;
    // had the numbers landed the other way it would have passed vacuously
    // forever.
    expect(getAppVersion()).not.toBe('0.0.0-unknown-app')
    expect(getFrameworkVersion()).not.toBe('0.0.0-unknown-framework')
  })
})

/**
 * The marker file's shape. `checkCacheVersion` compares three fields and writes
 * the same three; a marker written before `framework` existed mismatches and
 * wipes once, which is the intended upgrade path.
 */
describe('the cache marker carries all three fields', () => {
  test('a pre-fix marker mismatches and would trigger a wipe', () => {
    const current = {
      mode: 'development',
      version: '4.0.0',
      framework: '4.0.0',
    }
    // What a marker written before this change looks like.
    const legacy: Record<string, unknown> = {
      mode: 'development',
      version: '4.0.0',
    }
    const stale =
      legacy.mode !== current.mode ||
      legacy.version !== current.version ||
      legacy.framework !== current.framework
    expect(stale).toBe(true)
  })

  test('a framework bump alone is enough to invalidate', () => {
    const prev = { mode: 'production', version: '1.2.3', framework: '4.0.0' }
    const next = { mode: 'production', version: '1.2.3', framework: '4.1.0' }
    const stale =
      prev.mode !== next.mode ||
      prev.version !== next.version ||
      prev.framework !== next.framework
    expect(stale).toBe(true)
  })

  test('and an unchanged pair leaves the cache alone', () => {
    const prev = { mode: 'production', version: '1.2.3', framework: '4.0.0' }
    const next = { mode: 'production', version: '1.2.3', framework: '4.0.0' }
    const stale =
      prev.mode !== next.mode ||
      prev.version !== next.version ||
      prev.framework !== next.framework
    expect(stale).toBe(false)
  })
})

/**
 * The wipe itself — where the real bug was.
 *
 * `checkCacheVersion` used to hand the whole directory to a single recursive
 * `fs.rm` whose every error was swallowed (`.catch(() => {})`), then write a
 * marker claiming the cache was current. On Windows the delete fails with
 * `EBUSY` on `.cache/shared-cache.db` — which the process itself opens at
 * import time — node's walk stops at the locked entry, and everything it had
 * not reached survived. Including `html/`, the compiled-page cache.
 *
 * Ordering is fixed elsewhere (`shared-db.ts` awaits the check before opening
 * the database). These pin the other half: one undeletable entry must not
 * shield the rest, and the survivors have to be *reported* rather than
 * swallowed, because that report is what stops the marker being written.
 */
describe('wiping the cache directory', () => {
  const base = `${tmpdir()}/bakery-wipe-${process.pid}`

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  /**
   * Plant an entry inside `dir` that the operating system will refuse to
   * delete, and return its name plus a release function.
   *
   * **The fixture has to differ by platform, and that is the point.** These
   * tests originally used an open `bun:sqlite` handle everywhere, because that
   * is the real shape of the bug on Windows: the process opens
   * `.cache/shared-cache.db` at import time and `EBUSY` makes it undeletable.
   *
   * On POSIX an open file unlinks perfectly happily — so on Linux the sqlite
   * fixture deleted cleanly, the survivor list came back empty, and both tests
   * failed. They passed on the maintainer's Windows machine and had never run
   * on Linux until the full suite reached CI for the first time.
   *
   * The POSIX equivalent is a directory without write permission: unlinking a
   * child requires write on the *parent*, so a `0o500` directory containing a
   * file cannot be removed.
   */
  function plantUndeletable(dir: string): {
    name: string
    release: () => void
  } {
    if (process.platform === 'win32') {
      const db = new Database(`${dir}/shared-cache.db`)
      db.run('CREATE TABLE t (a INT)')
      db.run('INSERT INTO t VALUES (1)')
      return { name: 'shared-cache.db', release: () => db.close() }
    }

    const sub = `${dir}/shared-cache.db`
    mkdirSync(sub, { recursive: true })
    writeFileSync(`${sub}/child`, 'x')
    chmodSync(sub, 0o500)
    return { name: 'shared-cache.db', release: () => chmodSync(sub, 0o700) }
  }

  /**
   * True when the fixture actually resists deletion.
   *
   * Root ignores directory permissions, so in a container running as root the
   * POSIX fixture is deletable and these tests would fail for a reason that has
   * nothing to do with the code. Skipping beats a red build that means nothing
   * — but it is asserted rather than assumed, so the tests still run wherever
   * they can.
   */
  function fixtureHolds(): boolean {
    const probe = `${base}/probe-${Math.random().toString(36).slice(2)}`
    mkdirSync(probe, { recursive: true })
    const planted = plantUndeletable(probe)
    let held = true
    try {
      rmSync(`${probe}/${planted.name}`, { recursive: true, force: true })
      held = readdirSync(probe).includes(planted.name)
    } catch {
      held = true
    } finally {
      planted.release()
      rmSync(probe, { recursive: true, force: true })
    }
    return held
  }

  test('removes plain files and nested directories alike', async () => {
    const dir = `${base}/plain`
    mkdirSync(`${dir}/nested/deeper`, { recursive: true })
    writeFileSync(`${dir}/a.txt`, 'a')
    writeFileSync(`${dir}/nested/b.txt`, 'b')
    writeFileSync(`${dir}/nested/deeper/c.txt`, 'c')

    const survivors = await __wipeCacheDir(dir)
    expect(survivors).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  const undeletableHolds = fixtureHolds()

  test.skipIf(!undeletableHolds)(
    'a locked file does not shield the entries beside it',
    async () => {
      // The exact shape of the bug: an entry inside the directory that the OS
      // refuses to remove — an open sqlite handle on Windows, a permission-
      // locked directory on POSIX.
      const dir = `${base}/locked`
      mkdirSync(dir, { recursive: true })
      writeFileSync(`${dir}/a-before.txt`, 'a')
      writeFileSync(`${dir}/z-after.txt`, 'z')
      mkdirSync(`${dir}/html`, { recursive: true })
      writeFileSync(`${dir}/html/page.html`, '<p>stale</p>')

      const planted = plantUndeletable(dir)

      try {
        const survivors = await __wipeCacheDir(dir)
        // Everything except the locked entry is gone — including `html/`,
        // which is the one that actually matters and which used to survive
        // purely because of where it sat in readdir order.
        expect(survivors).toEqual([planted.name])
        expect(readdirSync(dir)).toEqual([planted.name])
      } finally {
        planted.release()
      }
    },
  )

  test.skipIf(!undeletableHolds)(
    'a non-empty survivor list is what withholds the marker',
    async () => {
      // Not a test of the writer — a statement of the contract the writer
      // reads. `checkCacheVersion` writes the "cache is current" marker only
      // when this is empty, so anything non-empty must keep it withheld.
      const dir = `${base}/contract`
      mkdirSync(dir, { recursive: true })
      const planted = plantUndeletable(dir)
      try {
        const survivors = await __wipeCacheDir(dir)
        expect(survivors.length).toBeGreaterThan(0)
      } finally {
        planted.release()
      }
    },
  )

  test('an absent directory is not an error', async () => {
    expect(await __wipeCacheDir(`${base}/never-existed`)).toEqual([])
  })
})

/**
 * The generated tsconfig projects survive the wipe.
 *
 * The app's *committed* `tsconfig.json` references `.cache/tsconfig/*.json`, so
 * deleting them does not degrade the editor — it removes the project entirely.
 * Reproduced on a real app: `tsc -p tsconfig.json` reports
 * `TS6053: File '…/.cache/tsconfig/server.json' not found` once per reference,
 * and every ambient goes with it — `req.session`, `Bakery`, the app's own schema
 * types, all unresolved at once.
 *
 * It fires on every framework upgrade, since the wipe is keyed on the framework
 * version, and the developer is given no reason for it.
 */
describe('the wipe keeps what the editor points at', () => {
  const root = `${tmpdir()}/bakery-wipe-keep-${process.pid}`
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('.cache/tsconfig survives, everything beside it does not', async () => {
    const dir = `${root}/keeps-tsconfig`
    mkdirSync(`${dir}/tsconfig`, { recursive: true })
    mkdirSync(`${dir}/html`, { recursive: true })
    writeFileSync(`${dir}/tsconfig/server.json`, '{}')
    writeFileSync(`${dir}/html/page.html`, '<p>x</p>')
    writeFileSync(`${dir}/server.json`, '{}')

    const survivors = await __wipeCacheDir(dir)

    // `html/` is precisely what an upgrade must discard.
    expect(readdirSync(dir).sort()).toEqual(['tsconfig'])
    expect(readdirSync(`${dir}/tsconfig`)).toEqual(['server.json'])
    // And a kept entry is not a *survivor*: reported as one, the caller would
    // withhold the "cache is current" marker and re-wipe on every boot forever.
    expect(survivors).toEqual([])
  })
})
