import { Bakery } from '../../core/bakery'
import { Try } from '../../utils/common'
import { fs } from '../../utils/fs'
import { resolveMount } from './$mounts'

/**
 * Literal file resolution — the static counterpart to `getRoute`.
 *
 * `getRoute` answers "which file backs this *route*", with extensionless URLs,
 * dynamic `[id]` segments and glob scanning. This answers the simpler question
 * "which file is at this path, and am I allowed to serve it".
 *
 * It exists because four handlers were each spelling that out themselves —
 * StaticHandler, PublicHandler, ImageHandler and NMHandler — in four slightly
 * different ways, and only some of them checked everything. Once route mounts
 * arrived the drift got worse: a mount-aware StaticHandler sitting next to a
 * mount-blind PublicHandler is the kind of inconsistency that turns into a bug
 * the first time someone mounts a directory containing an upload.
 *
 * **Three of those four go through this; NMHandler does not, on purpose.** Its
 * entry point is resolved by `Bun.build`, not by the filesystem, so
 * `/_nm/pkg/sub` legitimately means `pkg/sub/index.js` — a path this function
 * answers `null` for, because it is a directory. It therefore repeats the
 * containment test and calls `fs.isForbidden` itself; the reasoning, and the
 * test that pins the divergence, are in `handlers/assets/nm.ts`. It is the one
 * documented exception, and it stayed a *silent* one long enough for `/_nm/*`
 * to be the only file-serving surface that ignored `.forbidden`.
 */
export interface StaticTarget {
  /** Absolute path to the file on disk. */
  file: fs.AbsolutePath
  /** The root it was resolved against; containment is relative to this. */
  root: fs.AbsolutePath
  /** True when a route mount supplied the root rather than app config. */
  mounted: boolean
}

/**
 * Resolve `path` to a servable file, or null.
 *
 * A registered mount wins over `roots`: the prefix is stripped and the mount
 * directory becomes both the search root and the containment boundary, so a
 * mounted plugin cannot be traversed out of.
 *
 * Roots are tried in order, and a root that fails containment is skipped
 * rather than aborting — mirroring ImageHandler, which legitimately looks in
 * both the serve root and the public root.
 */
export async function getStatic(
  path: string,
  roots: string | string[] = Bakery.serveRoot,
): Promise<StaticTarget | null> {
  const mounted = resolveMount(path)

  const candidates: { root: string; relative: string }[] = mounted
    ? [{ root: mounted.mount.dir, relative: mounted.rest }]
    : (Array.isArray(roots) ? roots : [roots]).map(root => ({
        root,
        relative: path.replace(/^\/+/, ''),
      }))

  for (const candidate of candidates) {
    const root = fs.resolve(candidate.root)
    const file = fs.resolve(root, candidate.relative)

    // Two checks, not one: the prefix test catches a resolved path that
    // escaped the root, and isForbidden additionally honours `.forbidden`
    // markers. It does *not* apply the blocked globs — `Bakery.config.blocked`
    // is matched against the request path in `router.ts` and again in
    // `handlers/assets/static.ts`, never against a resolved file path — so a
    // caller reaching for `getStatic` as a one-stop authorisation check is
    // getting containment and `.forbidden` only.
    //
    // Containment stays first — nothing stats a path that escaped the root.
    // After that the order is by cost: `isForbidden` walks every directory
    // between the file and the root, so running it before the existence check
    // paid for a whole tree-walk on every candidate that simply is not there —
    // which is most of them, since a miss here is how each root in the list,
    // and every extensionless probe, gets ruled out. All checks are pure and
    // all `continue`, so the candidate chosen is unchanged.
    //
    // One stat answers both questions. This used to be `fs.exists` (a stat)
    // then `fs.isDir` (which is `fs.exists` plus a second stat of its own) —
    // up to three stats per candidate at ~28us each on Bun/Windows. A failed
    // stat means "nothing servable here" and falls through to the next
    // candidate, exactly as the exists check did.
    if (file !== root && !file.startsWith(`${root}/`)) continue
    const stat = await Try(() => Bun.file(file).stat())
    if (!stat || stat.isDirectory()) continue
    if (fs.isForbidden(file, root)) continue

    return {
      file: file as fs.AbsolutePath,
      root: root as fs.AbsolutePath,
      mounted: Boolean(mounted),
    }
  }

  return null
}
