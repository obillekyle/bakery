import { readdir, rm } from 'node:fs/promises'
import { serveLog } from '../logger/serve-log'
import { Try } from '../utils/common'
import { fs } from '../utils/fs'
import { Bakery } from './bakery'
import { getAppVersion, getFrameworkVersion } from './context'

/**
 * Discard `.cache/` when the thing that produced it has changed.
 *
 * Its own module, and that is the fix rather than an organizational
 * preference. This used to live in `config.ts` and run from `initConfig()`,
 * which is far too late: `cache/shared-db.ts` opens `.cache/shared-cache.db`
 * at **import** time, so by the time the check ran the process was already
 * holding a handle to a file inside the directory it was about to delete. On
 * Windows that delete fails with `EBUSY`, node's recursive walk stops at the
 * locked entry, and everything it had not reached yet survived, including
 * `html/`, the compiled-page cache, which is exactly what a version bump has
 * to discard.
 *
 * Now `shared-db.ts` awaits this before opening the database, and `initConfig`
 * still calls it for the case where nothing has touched the cache yet. It is
 * memoized, so whichever gets there first does the work and the other is free.
 */
let done: Promise<void> | null = null

export function checkCacheVersion(): Promise<void> {
  done ??= run()
  return done
}

/** Every field that decides whether a compiled artifact is still valid. */
export interface CacheMarker {
  mode: string
  version: string
  framework: string
  runtime: string
}

/**
 * Whether a marker describes a cache the current process can still use.
 *
 * Exported and called rather than restated, which is the point. The tests
 * beside this file used to write the comparison out a second time and assert
 * on their own copy - so they passed whichever fields the real code compared,
 * and would have gone on passing if one were dropped. Adding `runtime` is what
 * made that visible: three tests agreed the marker "carries all three fields"
 * while the code had four.
 *
 * A missing field reads as stale, which is the intended upgrade path. A marker
 * written before a field existed describes a cache built under conditions
 * nobody recorded, and one wipe is cheaper than guessing.
 */
export function isCacheStale(
  prev: Partial<CacheMarker> | null | undefined,
  current: CacheMarker,
): boolean {
  if (!prev) return true
  return (
    prev.mode !== current.mode ||
    prev.version !== current.version ||
    prev.framework !== current.framework ||
    prev.runtime !== current.runtime
  )
}

/** Test seam: forget that the check ran, so a fixture can exercise it again. */
export function __resetCacheVersionCheck(): void {
  done = null
}

async function run(): Promise<void> {
  // Workers inherit a directory the master already validated. Re-running here
  // would race the master's own wipe.
  if (import.meta.env.WORKER) return

  // Read from `Bakery.cacheDir`, never re-derived from `fs.cwd`. This value is
  // handed straight to a recursive delete below, and it used to be a
  // hand-written copy of the constant in `core/bakery.ts`: two sources of
  // truth for a `rm -rf`. Renaming the cache directory in one place and not the
  // other would have pointed this delete at whatever the stale literal named.
  const cacheDir = Bakery.cacheDir
  const markerPath = `${cacheDir}/server.json`

  const current = {
    mode: import.meta.env.DEV ? 'development' : 'production',
    // The app's version and the framework's are both here, and they are
    // different files on purpose: keying on the app alone meant
    // `bun update @bakery-framework/core` left a cache compiled by the previous
    // framework version, with nothing to invalidate it.
    version: getAppVersion(),
    framework: getFrameworkVersion(),
    // **And the runtime, for exactly the same reason one level down.**
    //
    // This directory holds *compiled and bundled output* - `html/`, `static/`,
    // `ts_cache/`, the console bundle. Bun's transpiler and bundler produce it,
    // so a Bun upgrade changes what a correct entry looks like, and nothing
    // here used to notice.
    //
    // Not hypothetical, and found the day it happened. Bun 1.4.1 reworked the
    // bundler's barrel optimization across ten commits: 1.4.0 emptied a
    // `sideEffects: false` re-export entry to `export { a };` with no
    // declaration, which is the husk `compiler.ts` carries a repair for. So a
    // cache written by 1.4.0 can hold a husk that the running 1.4.2 would
    // never have produced, and would have served it for the life of the
    // install. 1.4.1 is worse in a quieter way: a bundle it built can rename a
    // `let` onto a function parameter's name and compute **wrong values**
    // while loading perfectly (oven-sh/bun#41354).
    //
    // `Bun.version` rather than `Bun.revision`: a canary build of the same
    // version is a real distinction, but invalidating on every canary would
    // wipe the cache of anyone tracking one, and the failure this prevents is
    // a released bundler change.
    runtime: Bun.version,
  }

  const [err, prev] = await Try.catch(() => Bun.file(markerPath).json())
  if (!err && !isCacheStale(prev, current)) return

  const survivors = await wipe(cacheDir)
  if (!fs.exists(cacheDir)) await fs.mkdir(cacheDir)

  // The marker is written **only** when the directory is actually empty.
  //
  // It used to be written unconditionally, right after a delete whose every
  // error was swallowed, so a failed wipe produced a file asserting the cache
  // was current, and nothing ever tried again. A stale compiled page then
  // outlived the upgrade that was supposed to remove it, silently and
  // permanently. Leaving the old marker in place costs one retry per boot and
  // is the only honest option: the cache is not current, so nothing should say
  // it is.
  if (survivors.length) {
    serveLog.CACHE_WIPE_INCOMPLETE({
      dir: cacheDir,
      files: survivors.join(', '),
    })
    return
  }

  await Bun.write(markerPath, `${JSON.stringify(current, null, 2)}\n`)
}

/**
 * Empty `dir`, entry by entry. Returns whatever is still there.
 *
 * Per-entry rather than one recursive call on the directory itself, because a
 * single locked file otherwise shields every entry the walk had not yet
 * reached: the failure is ordering-dependent, so it presents as "sometimes the
 * cache clears".
 */
export const __wipeCacheDir = wipe

/**
 * The one thing in `.cache/` the wipe must not take.
 *
 * **The app's committed `tsconfig.json` *references* `.cache/tsconfig/*.json`,
 * so deleting them breaks the editor for the whole project**, not one setting,
 * everything. TypeScript reports `TS6053: File '…/server.json' not found` for
 * each reference, has no project left to put a file in, and falls back to an
 * inferred one with no ambients: `req.session`, `Bakery`, the JSX namespace and
 * the app's own schema types all stop resolving at once.
 *
 * That happens on every framework upgrade, because the version wipe is keyed on
 * the framework version among others. The developer sees their editor lose every
 * type the moment they bump a patch, and nothing says why: the files come back
 * only on the next `bun run dev`, which is not an obvious remedy for "my types
 * vanished".
 *
 * Keeping them is safe in the direction that matters. A stale project is
 * regenerated on the next dev boot and is, in the meantime, *approximately
 * right*, while a missing one is catastrophically wrong. Nothing is executed
 * from these files either: they configure a typechecker, so the "never read a
 * cache an older framework wrote" rule the wipe exists to enforce does not apply.
 */
const WIPE_KEEP = new Set(['tsconfig'])

async function wipe(dir: string): Promise<string[]> {
  if (!fs.exists(dir)) return []
  const [readErr, entries] = await Try.catch(() => readdir(dir))
  if (readErr || !entries) return ['<unreadable>']

  for (const entry of entries) {
    if (WIPE_KEEP.has(entry)) continue
    // Errors are deliberately not swallowed *silently* here: each failure is
    // collected and reported by the caller.
    await Try.catch(() =>
      rm(`${dir}/${entry}`, { recursive: true, force: true }),
    )
  }

  const [rereadErr, left] = await Try.catch(() => readdir(dir))
  if (rereadErr) return ['<unreadable>']
  // Kept entries are not survivors of a failed delete, and reporting them as
  // such would make the caller withhold the "cache is current" marker forever.
  return (left ?? []).filter(entry => !WIPE_KEEP.has(entry))
}
