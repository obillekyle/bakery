export const DEFAULT_PORT = 3000
export const DEFAULT_HOST = '0.0.0.0'

export const DEFAULT_DB_BACKUPS = 10

export const DEFAULT_SESSION_TTL = 1000 * 60 * 60 // 1 hour in ms
export const DEFAULT_SESSION_PERSIST = DEFAULT_SESSION_TTL * 24 * 30 // 30 days in ms

export const DEFAULT_RATE_LIMIT = { max: 100, refill: 10 }

/**
 * Files that must never be served off disk.
 *
 * These are matched against the file a *file-serving* handler is about to
 * return, not against every request path — see `servesFiles` in `router.ts`.
 * An API route or a proxied path is a name, not a file, and never had any
 * business being tested against this list.
 *
 * **Every pattern here must stay lower-case.** `matchBlocked` below folds the
 * request path to lower case before the second of its two match attempts, and
 * an upper-case character in a default pattern would be silently unreachable
 * on that attempt.
 *
 * Note what is *not* here: an extension-wide ban on JSON. It caught every
 * JSON document an app might legitimately publish — a web app manifest, a
 * `.well-known` document — and since `blocked` in config can only ever append,
 * an app had no way to opt back out. What the list is actually protecting is
 * the handful of JSON files that describe the project, so those are named.
 */
export const DEFAULT_BLOCKED_GLOBS = [
  '**/.env',
  '**/*.env',
  '**/*.sql',
  '**/*.db',
  '**/package.json',
  '**/package-lock.json',
  '**/tsconfig.json',
  '**/tsconfig.*.json',
  '**/*.yaml',
  '**/*.yml',
  '**/*.lock',
  // `bun.lock` is covered by `*.lock`; the binary lockfile is not.
  '**/bun.lockb',
  // `dir/**/*`, not `dir/**`. These patterns are joined into a single
  // brace-expanded glob by `initConfig`, and inside a brace group Bun's
  // trailing `**` collapses to a single segment: `{**/node_modules/**}` matches
  // `/node_modules/a` and then stops, so `/node_modules/pkg/index.js` was not
  // blocked by anything. Each pattern still matched on its own, which is why
  // it survived — the defect only exists in the form the config actually uses.
  '**/.bakery/**/*',
  '**/.data/**/*',
  '**/_internal/**/*',
  '**/.git/**/*',
  '**/.vscode/**/*',
  '**/node_modules/**/*',
  '**/server.config.ts',
  '**/schema.ts',
  '**/.gitignore',
  '**/*.exe',
]

/**
 * A request path folded to the form the *filesystem* would resolve it to.
 *
 * Two normalisations, both of them things the OS does and the glob does not:
 *
 * - **Case.** NTFS and APFS are case-insensitive, so `/PACKAGE.JSON` opens the
 *   same bytes as `/package.json` — but `Bun.Glob` is case-sensitive, so only
 *   the second one was blocked. Every file this list protects was reachable by
 *   holding down shift, and the static pipeline was verified to serve
 *   `/STYLES/GLOBAL.CSS` and `/styles/global.css` as the same 170 bytes.
 * - **Trailing dots and spaces.** Win32 strips both from each path component,
 *   so `/package.json.` and `/package.json ` are the same file too.
 *
 * `.`, `..` and any all-dots component are left intact — trimming those would
 * rewrite a relative segment into something else, and containment is
 * `fs.isForbidden`'s job, not this function's.
 */
export function normalizeBlockedPath(path: string): string {
  return path
    .toLowerCase()
    .split('/')
    .map(segment => segment.replace(/[. ]+$/, '') || segment)
    .join('/')
}

/**
 * Each path component truncated at its first `:`.
 *
 * Win32 resolves `x.ts::$DATA` to the bytes of `x.ts` and
 * `dir::$INDEX_ALLOCATION` to `dir` — NTFS alternate-data-stream syntax — and
 * `new URL()` keeps the suffix in `pathname`, so a glob anchored on the real
 * name missed while the filesystem opened the file anyway. The directory form
 * matters independently: it defeats the `dir/**` patterns that the file form
 * cannot reach.
 *
 * Only ever used as an *extra* match candidate (see `matchBlocked`), never as
 * a replacement — colons are legal in POSIX filenames, and a real file named
 * `a:b.db` must stay blocked by `*.db` rather than being tested as `a`.
 */
function stripStreamSuffix(path: string): string {
  if (!path.includes(':')) return path
  return path
    .split('/')
    .map(segment => {
      const colon = segment.indexOf(':')
      return colon === -1 ? segment : segment.slice(0, colon) || segment
    })
    .join('/')
}

/**
 * Whether `path` is refused by the blocked globs.
 *
 * Matched twice: once as written, once normalised. Both are needed, and for
 * different reasons. The normalised pass is what closes the case and
 * trailing-dot variants above. The verbatim pass is what keeps an app's own
 * `blocked: ['**\/Secrets.txt']` working — `initConfig` appends user patterns
 * to this list untouched, so folding only the path would quietly stop matching
 * the very patterns the app wrote.
 *
 * On a case-*sensitive* filesystem this over-blocks: a file genuinely named
 * `/PACKAGE.JSON`, distinct from `/package.json`, is refused. That is the
 * intended direction to be wrong in, and it is the reason this normalises the
 * path rather than resolving the file. The router runs this check before it
 * knows which file — often before there is a file at all — so "ask the
 * filesystem for the real name" is not available at the point the answer is
 * needed, and would cost a `realpath` per request where it was.
 */
export function matchBlocked(
  blocked: { match(path: string): boolean } | undefined,
  path: string,
): boolean {
  if (!blocked) return false
  if (blocked.match(path)) return true

  // Candidates are only ever *added*, never substituted, so no form of this
  // can unblock something a plainer form already caught.
  const normalized = normalizeBlockedPath(path)
  if (normalized !== path && blocked.match(normalized)) return true

  const stripped = stripStreamSuffix(path)
  if (stripped === path) return false
  if (blocked.match(stripped)) return true

  const strippedNormalized = normalizeBlockedPath(stripped)
  return strippedNormalized !== stripped && blocked.match(strippedNormalized)
}
