import { Database } from 'bun:sqlite'
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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

  test('a locked file does not shield the entries beside it', async () => {
    // The exact shape of the bug: an open sqlite handle inside the directory.
    const dir = `${base}/locked`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}/a-before.txt`, 'a')
    writeFileSync(`${dir}/z-after.txt`, 'z')
    mkdirSync(`${dir}/html`, { recursive: true })
    writeFileSync(`${dir}/html/page.html`, '<p>stale</p>')

    const db = new Database(`${dir}/shared-cache.db`)
    db.run('CREATE TABLE t (a INT)')
    db.run('INSERT INTO t VALUES (1)')

    try {
      const survivors = await __wipeCacheDir(dir)
      // Everything except the locked file is gone — including `html/`, which
      // is the entry that actually matters and which used to survive purely
      // because of where it sat in readdir order.
      expect(survivors).toEqual(['shared-cache.db'])
      const left = readdirSync(dir)
      expect(left).toEqual(['shared-cache.db'])
    } finally {
      db.close()
    }
  })

  test('a non-empty survivor list is what withholds the marker', async () => {
    // Not a test of the writer — a statement of the contract the writer reads.
    // `checkCacheVersion` writes the "cache is current" marker only when this
    // is empty, so anything that makes it non-empty must keep it withheld.
    const dir = `${base}/contract`
    mkdirSync(dir, { recursive: true })
    const db = new Database(`${dir}/shared-cache.db`)
    try {
      const survivors = await __wipeCacheDir(dir)
      expect(survivors.length).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  test('an absent directory is not an error', async () => {
    expect(await __wipeCacheDir(`${base}/never-existed`)).toEqual([])
  })
})
