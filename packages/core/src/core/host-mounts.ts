/**
 * Host mounts: a host that serves one path subtree of the app at its root.
 *
 * `hostMounts: [{ host: 'kit.*', path: '/kit' }]` makes `kit.example.com/forms`
 * the page `/kit/forms` is on every other host. The subtree stays part of the
 * app: its pages load the app's modules, stylesheets and API from the root,
 * the way they do on any host, so only page requests move into it. Which
 * requests those are is `routeOf` in `router.ts`.
 *
 * Patterns rather than `hosts` keys, because a mount's hostname is often not
 * known at boot: an app whose domain is a setting can still name "the `kit`
 * label of whatever domain this is". A mount is also not a tenant. It changes
 * which page a path names and nothing else, so sessions, caches and the
 * `hosts` entries do not see it.
 */

export type HostMount = {
  /**
   * The hostnames the mount serves: a name (`kit.example.com`), a pattern in
   * which `*` stands for one or more whole labels (`kit.*`,
   * `*.docs.example.com`), or a function of the hostname, which it receives
   * lowercased and without the port.
   */
  host: string | ((hostname: string) => boolean)
  /** The subtree served at the host's root, such as `/kit`. */
  path: string
}

export type CompiledHostMount = {
  /** The subtree: a leading slash and no trailing one. */
  readonly path: string
  /** Whether a lowercased hostname without its port is served by the mount. */
  matches(hostname: string): boolean
}

/** One label of a hostname pattern, `*` aside. */
const LABEL = /^[a-z0-9_-]+$/

/** `*` as a pattern label: one or more whole labels. */
const ANY_LABELS = '[^.]+(?:\\.[^.]+)*'

/**
 * A hostname pattern as a regular expression. Throws naming `where` when
 * `host` is not a name, or puts `*` inside a label: `k*t.example.com` would
 * have to choose between matching part of a label and matching labels, and
 * either reading surprises someone.
 */
export function hostPattern(host: string, where = 'host'): RegExp {
  const labels = host.toLowerCase().split('.')
  if (labels.some(label => label === '')) {
    throw new Error(
      `${where} '${host}' is not a hostname: a name has no empty label`,
    )
  }
  const parts = labels.map(label => {
    if (label === '*') return ANY_LABELS
    if (!LABEL.test(label)) {
      throw new Error(
        `${where} '${host}' has the label '${label}': a label is letters, digits, '-' and '_', and '*' stands for whole labels only`,
      )
    }
    return label
  })
  return new RegExp(`^${parts.join('\\.')}$`)
}

/**
 * What every host serves from the app's root, a mounted one included: the
 * framework's and the plugins' routes, the API, and the site-wide metadata
 * RFC 8615 reserves. The router keeps requests under these out of a mount,
 * and no mount may name a path under one.
 */
export const ROOT_ONLY = ['/_', '/api/', '/.well-known/'] as const

function mountPath(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new Error(
      `${where} must be a path starting with '/': got ${JSON.stringify(value)}`,
    )
  }
  const path = value.replace(/\/+$/, '')
  if (path === '') {
    throw new Error(
      `${where} '${value}' is the whole app, which every host already serves`,
    )
  }
  const segments = path.slice(1).split('/')
  if (segments.some(s => s === '' || s === '.' || s === '..')) {
    throw new Error(
      `${where} '${value}' has an empty, '.' or '..' segment: a mount names one directory`,
    )
  }
  if (/[?#*\\]/.test(path)) {
    throw new Error(
      `${where} '${value}' is a path, so it holds no '?', '#', '*' or '\\'`,
    )
  }
  const reserved = ROOT_ONLY.find(prefix => `${path}/`.startsWith(prefix))
  if (reserved) {
    throw new Error(
      `${where} '${value}' is under ${reserved}, which every host serves as it is`,
    )
  }
  return path
}

function compile(mount: HostMount, where: string): CompiledHostMount {
  if (!mount || typeof mount !== 'object') {
    throw new Error(`${where} must be { host, path }`)
  }
  const path = mountPath(mount.path, `${where}.path`)
  const { host } = mount
  if (typeof host === 'function') return { path, matches: host }
  if (typeof host !== 'string') {
    throw new Error(
      `${where}.host must be a hostname, a pattern such as 'kit.*', or a function of the hostname`,
    )
  }
  const pattern = hostPattern(host, `${where}.host`)
  return { path, matches: hostname => pattern.test(hostname) }
}

/**
 * Compiled once per array: the processed config is frozen for the life of
 * the process, and a test that swaps it in brings a new array, so identity is
 * the whole validity check.
 */
const compiled = new WeakMap<
  readonly HostMount[],
  readonly CompiledHostMount[]
>()

/** `hostMounts` compiled, throwing at the first entry that cannot mean anything. */
export function compileHostMounts(
  mounts: readonly HostMount[],
): readonly CompiledHostMount[] {
  const cached = compiled.get(mounts)
  if (cached) return cached
  if (!Array.isArray(mounts)) {
    throw new Error('hostMounts must be an array of { host, path }')
  }
  const result = mounts.map((mount, i) => compile(mount, `hostMounts[${i}]`))
  compiled.set(mounts, result)
  return result
}

/**
 * Compile the app's `hostMounts` before anything binds, so an entry that
 * cannot mean anything stops the boot and names itself, rather than throwing
 * on the first request that reaches it.
 */
export function checkHostMounts(config: {
  hostMounts: readonly HostMount[]
}): void {
  compileHostMounts(config.hostMounts)
}

/** The first mount serving `hostname`, or null. */
export function findHostMount(
  mounts: readonly CompiledHostMount[],
  hostname: string,
): CompiledHostMount | null {
  if (!mounts.length) return null
  const host = hostname.toLowerCase()
  for (const mount of mounts) {
    if (mount.matches(host)) return mount
  }
  return null
}

/** `path` on a mounted host, as the app names it: `/` is the mount itself. */
export function mountedPath(path: string, mount: string): string {
  return path === '/' ? mount : `${mount}${path}`
}
