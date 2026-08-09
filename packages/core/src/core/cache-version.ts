import { readdir, rm } from 'node:fs/promises'
import { serveLog } from '../logger/serve-log'
import { Try } from '../utils/common'
import { fs } from '../utils/fs'
import { Bakery } from './bakery'
import { getAppVersion, getFrameworkVersion } from './context'

/**
 * Discard `.cache/` when the thing that produced it has changed.
 *
 * Its own module, and that is the fix rather than an organisational
 * preference. This used to live in `config.ts` and run from `initConfig()`,
 * which is far too late: `cache/shared-db.ts` opens `.cache/shared-cache.db`
 * at **import** time, so by the time the check ran the process was already
 * holding a handle to a file inside the directory it was about to delete. On
 * Windows that delete fails with `EBUSY`, node's recursive walk stops at the
 * locked entry, and everything it had not reached yet survived — including
 * `html/`, the compiled-page cache, which is exactly what a version bump has
 * to discard.
 *
 * Now `shared-db.ts` awaits this before opening the database, and `initConfig`
 * still calls it for the case where nothing has touched the cache yet. It is
 * memoised, so whichever gets there first does the work and the other is free.
 */
let done: Promise<void> | null = null

export function checkCacheVersion(): Promise<void> {
  done ??= run()
  return done
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
  // hand-written copy of the constant in `core/bakery.ts` — two sources of
  // truth for a `rm -rf`. Renaming the cache directory in one place and not the
  // other would have pointed this delete at whatever the stale literal named.
  const cacheDir = Bakery.cacheDir
  const markerPath = `${cacheDir}/server.json`

  const current = {
    mode: import.meta.env.DEV ? 'development' : 'production',
    // The app's version and the framework's are both here, and they are
    // different files on purpose: keying on the app alone meant
    // `bun update @bakery/core` left a cache compiled by the previous
    // framework version, with nothing to invalidate it.
    version: getAppVersion(),
    framework: getFrameworkVersion(),
  }

  const [err, prev] = await Try.catch(() => Bun.file(markerPath).json())
  const stale =
    err ||
    !prev ||
    prev.mode !== current.mode ||
    prev.version !== current.version ||
    prev.framework !== current.framework

  if (!stale) return

  const survivors = await wipe(cacheDir)
  if (!fs.exists(cacheDir)) await fs.mkdir(cacheDir)

  // The marker is written **only** when the directory is actually empty.
  //
  // It used to be written unconditionally, right after a delete whose every
  // error was swallowed — so a failed wipe produced a file asserting the cache
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
 * reached — the failure is ordering-dependent, so it presents as "sometimes the
 * cache clears".
 */
export const __wipeCacheDir = wipe

async function wipe(dir: string): Promise<string[]> {
  if (!fs.exists(dir)) return []
  const [readErr, entries] = await Try.catch(() => readdir(dir))
  if (readErr || !entries) return ['<unreadable>']

  for (const entry of entries) {
    // Errors are deliberately not swallowed *silently* here — each failure is
    // collected and reported by the caller.
    await Try.catch(() =>
      rm(`${dir}/${entry}`, { recursive: true, force: true }),
    )
  }

  const [rereadErr, left] = await Try.catch(() => readdir(dir))
  if (rereadErr) return ['<unreadable>']
  return left ?? []
}
