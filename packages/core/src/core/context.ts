import { AsyncLocalStorage } from 'node:async_hooks'
import { matchBlocked } from '../utils/constants'
import { fs } from '../utils/fs'

export type HostContext = {
  config: Readonly<ProcessedAppConfig>
  hostname: string
  /**
   * Per-request memo of raw `.forbidden` marker probes, keyed by the marker
   * path (`<dir>/.forbidden`). Lazily created by `fs.isForbidden` and never
   * read anywhere else. Scoped to one request by construction: every
   * `hostStore.run` in the tree wraps a single request, WebSocket event or
   * error dispatch, so the map dies with the store. That is what keeps this
   * distinct from the cross-request cache `fs.isForbidden`'s regression test
   * forbids — see the block comment there. Bounded (convention 6) by request
   * lifetime: one request touches a handful of paths, each of bounded depth.
   */
  forbiddenProbes?: Map<string, boolean>
  /**
   * Per-request memo of `matchBlocked` verdicts keyed by request path — the
   * router runs the check before dispatch and `StaticHandler.handle` must
   * keep its own (direct callers bypass the router gate), so without this the
   * same globs matched the same path twice per static request. Sound to key
   * by path alone because both call sites pass the ambient host config's
   * globs, which are frozen for the life of the store.
   */
  blockedPaths?: Map<string, boolean>
}

export const hostStore = new AsyncLocalStorage<HostContext>()

/**
 * The two runtime directories, defined here rather than on `Bakery`.
 *
 * `Bakery.cacheDir` / `Bakery.dataDir` remain the way application and framework
 * code reads them — these are the single definition those two forward to, and
 * still the only writer of either path. They live in this module because it is
 * low enough to be imported without pulling in `core/config`, and therefore
 * without pulling in the logger: `compiler/prompt-tracker.ts` needs the cache
 * directory and reaching it through `Bakery` closed a module cycle that made
 * the whole package unimportable. See the note on `prompt-tracker.ts`.
 *
 * **Functions, not constants, and that is not a style choice.** `utils/fs.ts`
 * imports this module for `hostStore`, so the two are themselves a cycle: a
 * top-level `` `${fs.cwd}/.cache` `` here is evaluated with `fs` still
 * uninitialised whenever `core/context` is reached first, and throws
 * `TypeError: undefined is not an object`. Reading `fs.cwd` at call time is
 * what makes the order irrelevant.
 *
 * The disposable directory is the hidden one, and the precious one is not. This
 * is the reverse of the old `.bakery/cache` + `.data` pairing, and the reversal
 * is the whole point: `.cache` is wiped by the framework itself on every version
 * bump and dev<->prod switch, so a `rm -rf .*` or a "clean out the dotfiles"
 * sweep does exactly what the framework already does. The database is not
 * disposable, so it does not live behind a leading dot where such a sweep can
 * reach it, and never under `.cache` — clearing a cache must not destroy data.
 */
export function cacheDir(): string {
  return `${fs.cwd}/.cache`
}

export function dataDir(): string {
  return `${fs.cwd}/bakery`
}

/**
 * `matchBlocked`, deduplicated within the current request.
 *
 * Outside a request store (tests, direct handler calls) this is exactly
 * `matchBlocked` — no caching, fail closed on nothing, because nothing is
 * skipped. See `HostContext.blockedPaths` for the scoping argument.
 */
export function matchBlockedCached(
  blocked: { match(path: string): boolean } | undefined,
  path: string,
): boolean {
  const store = hostStore.getStore()
  const seen = store ? (store.blockedPaths ??= new Map()) : null

  let verdict = seen?.get(path)
  if (verdict === undefined) {
    verdict = matchBlocked(blocked, path)
    seen?.set(path, verdict)
  }
  return verdict
}

/**
 * What each version reader returns when it cannot read its manifest.
 *
 * They must be **distinct from each other and impossible as a real version**,
 * and both halves are load-bearing. Distinct, because the two readers exist to
 * be different files and a shared fallback would let one silently stand in for
 * the other. Impossible, because they used to be plain `'1.0.0'` and `'0.0.0'`
 * — and when the framework was renumbered to 1.0.0 for its first publish, the
 * app fallback became a legitimate framework version. Nothing broke at runtime,
 * but `cache-version.test.ts` could no longer tell "read the manifest" from
 * "fell back to the other one", so the guard was disarmed by a version bump.
 *
 * A prerelease suffix keeps them valid semver while making the collision
 * unrepeatable: no published version can equal these.
 */
const UNKNOWN_APP = '0.0.0-unknown-app'
const UNKNOWN_FW = '0.0.0-unknown-framework'

let _appVersion: string | null = null

/**
 * The **application's** version, from `<cwd>/package.json`.
 *
 * Not the framework's — this reads the manifest of whatever is being served.
 * The distinction is load-bearing for cache invalidation; see
 * {@link getFrameworkVersion}.
 */
export function getAppVersion() {
  if (_appVersion) return _appVersion
  try {
    const content = fs.readFileSync(fs.resolve(fs.cwd, 'package.json'))
    if (content) _appVersion = JSON.parse(content).version || UNKNOWN_APP
  } catch {
    // Missing or malformed package.json. The version is cosmetic and the
    // fallback below is the answer either way.
  }
  return _appVersion || UNKNOWN_APP
}

/**
 * The **framework's** version, from `@bakery-framework/core`'s own package.json.
 *
 * Resolved from this module's location rather than by package specifier: a
 * package self-referencing by name works only via the `exports` field and is
 * one config edit away from breaking, while `../../package.json` is the same
 * relative path in the repo and in the published tarball (`files` keeps both
 * `src/` and the manifest).
 *
 * This exists because `.cache/` invalidation was keyed on the *app's* version
 * alone, so upgrading `@bakery-framework/*` left a cache compiled by the previous
 * framework version in place. In-repo that was invisible: `apps/example`'s
 * version tracks the framework's, so bumping both wiped it anyway.
 */
let _frameworkVersion: string | null = null
export function getFrameworkVersion() {
  if (_frameworkVersion) return _frameworkVersion
  try {
    const content = fs.readFileSync(
      fs.resolve(import.meta.dir, '../../package.json'),
    )
    if (content) _frameworkVersion = JSON.parse(content).version || UNKNOWN_FW
  } catch {
    // Same reasoning as above, with one addition: a fallback that never
    // changes would silently stop invalidating the cache, so it is a distinct
    // value from the app fallback.
  }
  return _frameworkVersion || UNKNOWN_FW
}
