import { fs } from '../../utils'

/**
 * Route mounts: map a URL prefix onto a directory outside the app's serve root.
 *
 * Handlers resolve files under `Bakery.serveRoot`, so a plugin wanting to serve
 * its own pages or client assets had no choice but to hand-roll it — reading
 * files itself, bundling on the fly, and reimplementing the caching and
 * containment the handler pipeline already does. `DashboardHandler` is the
 * worked example of that cost.
 *
 * A mount lets a plugin say "paths under `/_dashboard` come from *my*
 * directory", after which the normal handlers (TSX, TS, HTML, static, the
 * compiler, the route cache) treat those files exactly like app files.
 *
 * Containment still applies: `getRoute` receives the mount directory as both
 * the search dir *and* the root, so traversal cannot escape it.
 */
export interface RouteMount {
  /** URL prefix, leading slash, no trailing slash — e.g. `/_dashboard`. */
  prefix: string
  /** Absolute directory the prefix resolves against. */
  dir: fs.AbsolutePath
}

/** Registered longest-prefix-first, so nested mounts resolve predictably. */
const mounts: RouteMount[] = []

function normalizePrefix(prefix: string): string {
  const withSlash = prefix.startsWith('/') ? prefix : `/${prefix}`
  return withSlash.length > 1 && withSlash.endsWith('/')
    ? withSlash.slice(0, -1)
    : withSlash
}

/**
 * Serve `prefix/*` from `dir`. Call from a plugin's `setup()`.
 *
 * Re-registering the same prefix replaces it, so a reloading dev worker does
 * not accumulate duplicates.
 */
export function mountRoutes(prefix: string, dir: string): RouteMount {
  const mount: RouteMount = {
    prefix: normalizePrefix(prefix),
    dir: fs.resolve(dir) as fs.AbsolutePath,
  }

  const existing = mounts.findIndex(m => m.prefix === mount.prefix)
  if (existing !== -1) mounts.splice(existing, 1)

  mounts.push(mount)
  mounts.sort((a, b) => b.prefix.length - a.prefix.length)
  return mount
}

/**
 * The mount owning `path`, plus the path relative to it, or null.
 *
 * A prefix matches only on a segment boundary: `/_dash` must not capture
 * `/_dashboard`.
 */
export function resolveMount(
  path: string,
): { mount: RouteMount; rest: string } | null {
  const normalized = path.startsWith('/') ? path : `/${path}`

  for (const mount of mounts) {
    if (normalized === mount.prefix) return { mount, rest: '' }
    if (normalized.startsWith(`${mount.prefix}/`)) {
      return { mount, rest: normalized.slice(mount.prefix.length + 1) }
    }
  }
  return null
}

/** Every registered mount, longest prefix first. */
export function getMounts(): readonly RouteMount[] {
  return mounts
}

/** Drop all mounts. Intended for tests. */
export function clearMounts(): void {
  mounts.length = 0
}
