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

let _bakeryVersion: string | null = null
export function getBakeryVersion() {
  if (_bakeryVersion) return _bakeryVersion
  try {
    const content = fs.readFileSync(fs.resolve(fs.cwd, 'package.json'))
    if (content) _bakeryVersion = JSON.parse(content).version || '1.0.0'
  } catch {
    // Missing or malformed package.json. The version is cosmetic and the
    // '1.0.0' fallback below is the answer either way.
  }
  return _bakeryVersion || '1.0.0'
}
