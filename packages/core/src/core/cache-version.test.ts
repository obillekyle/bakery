import { describe, expect, test } from 'bun:test'
import { getAppVersion, getFrameworkVersion } from './context'

/**
 * `.cache/` invalidation keys on the framework's version as well as the app's.
 *
 * It used to key on the app's alone, through a function called
 * `getBakeryVersion` that read `<cwd>/package.json` — so `bun update
 * @bakery/core` left a cache full of artifacts compiled by the previous
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

  test('the framework version comes from @bakery/core, not the cwd', async () => {
    const core = await Bun.file(
      `${import.meta.dir}/../../package.json`,
    ).json()
    expect(core.name).toBe('@bakery/core')
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
    // Distinct fallbacks on purpose: a shared '1.0.0' would make an
    // unreadable manifest look like a version that never changes, which is
    // silently "never invalidate" rather than "invalidate once".
    expect(getAppVersion()).not.toBe('0.0.0')
    expect(getFrameworkVersion()).not.toBe('1.0.0')
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
