import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_DB_BACKUPS,
  DEFAULT_SESSION_TTL,
  DEFAULT_SESSION_PERSIST,
  DEFAULT_RATE_LIMIT,
  DEFAULT_BLOCKED_GLOBS,
  matchBlocked,
  normalizeBlockedPath,
} from './constants'

describe('constants', () => {
  test('DEFAULT_PORT is 3000', () => {
    expect(DEFAULT_PORT).toBe(3000)
  })

  test('DEFAULT_HOST is 0.0.0.0', () => {
    expect(DEFAULT_HOST).toBe('0.0.0.0')
  })

  test('DEFAULT_DB_BACKUPS is 10', () => {
    expect(DEFAULT_DB_BACKUPS).toBe(10)
  })

  test('DEFAULT_SESSION_TTL is 1h in ms', () => {
    expect(DEFAULT_SESSION_TTL).toBe(1000 * 60 * 60)
  })

  test('DEFAULT_SESSION_PERSIST is 30 days in ms', () => {
    expect(DEFAULT_SESSION_PERSIST).toBe(DEFAULT_SESSION_TTL * 24 * 30)
  })

  test('DEFAULT_RATE_LIMIT has max and refill', () => {
    expect(DEFAULT_RATE_LIMIT.max).toBe(100)
    expect(DEFAULT_RATE_LIMIT.refill).toBe(10)
  })

  test('DEFAULT_BLOCKED_GLOBS includes sensitive files', () => {
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/.env')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/*.db')
    // The framework's working dir and the app's database must never be served.
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/.bakery/**/*')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/.data/**/*')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/node_modules/**/*')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/schema.ts')
  })
})

/**
 * `config.ts` joins the list into one brace-expanded glob, which is also the
 * shape the router matches against — so match through that, not through the
 * individual patterns.
 */
describe('DEFAULT_BLOCKED_GLOBS as a matcher', () => {
  const blocked = new Bun.Glob(`{${DEFAULT_BLOCKED_GLOBS.join(',')}}`)

  test('still blocks the files it exists for', () => {
    const secrets = [
      '/.env',
      '/config/.env',
      '/prod.env',
      '/dump.sql',
      '/server.db',
      '/.git/config',
      '/.gitignore',
      '/node_modules/left-pad/index.js',
      '/server.config.ts',
      '/schema.ts',
      '/.data/server.db',
      '/.data/backups/2024/dump.sqlite',
      '/.bakery/cache/x',
      '/.bakery/cache/nested/deep/x',
      '/node_modules/pkg/dist/index.js',
      '/_internal/notes/todo.md',
      '/.vscode/settings.json',
      '/package.json',
      '/package-lock.json',
      '/tsconfig.json',
      '/tsconfig.server.json',
      '/bun.lock',
      '/bun.lockb',
      '/deploy.yaml',
      '/ci.yml',
    ]

    expect(secrets.filter(p => !blocked.match(p))).toEqual([])
  })

  test('no longer bans JSON by extension', () => {
    // A web app manifest is a published asset, not a leaked source file, and
    // `blocked` in config can only append — so a blanket `**/*.json` was a ban
    // an app had no way to lift. See the note on DEFAULT_BLOCKED_GLOBS.
    const published = [
      '/manifest.json',
      '/uploads/manifest.json',
      '/.well-known/assetlinks.json',
      '/data/posts.json',
    ]

    expect(published.filter(p => blocked.match(p))).toEqual([])
  })
})

/**
 * The globs are matched against a request path, and two things the filesystem
 * does to a path the glob does not: fold case, and strip trailing dots and
 * spaces from each component. Verified before the fix: `/package.json` was
 * blocked and `/PACKAGE.JSON` was not.
 */
describe('matchBlocked', () => {
  const blocked = new Bun.Glob(`{${DEFAULT_BLOCKED_GLOBS.join(',')}}`)

  test('every default pattern is lower-case', () => {
    // The normalised pass folds the path, so an upper-case character in a
    // default pattern would be unreachable on that pass.
    const shouty = DEFAULT_BLOCKED_GLOBS.filter(p => p !== p.toLowerCase())
    expect(shouty).toEqual([])
  })

  test('blocks the case variants of every protected file', () => {
    const variants = [
      '/PACKAGE.JSON',
      '/Package.json',
      '/SERVER.CONFIG.TS',
      '/Server.Config.ts',
      '/SCHEMA.TS',
      '/.ENV',
      '/Config/.Env',
      '/DUMP.SQL',
      '/SERVER.DB',
      '/NODE_MODULES/left-pad/index.js',
      '/.GIT/config',
      '/.Data/server.db',
      '/BUN.LOCKB',
      '/DEPLOY.YAML',
    ]

    expect(variants.filter(p => !matchBlocked(blocked, p))).toEqual([])
  })

  test('blocks the Win32 trailing-dot variant', () => {
    // Win32 strips trailing dots and spaces from each component, so these open
    // the same file.
    const variants = ['/package.json.', '/PACKAGE.JSON.', '/schema.ts.']
    expect(variants.filter(p => !matchBlocked(blocked, p))).toEqual([])
  })

  test('still blocks the plain lower-case paths', () => {
    expect(matchBlocked(blocked, '/package.json')).toBe(true)
    expect(matchBlocked(blocked, '/.env')).toBe(true)
  })

  test('does not start blocking published assets', () => {
    const published = [
      '/manifest.json',
      '/MANIFEST.JSON',
      '/styles/global.css',
      '/STYLES/GLOBAL.CSS',
      '/.well-known/assetlinks.json',
    ]
    expect(published.filter(p => matchBlocked(blocked, p))).toEqual([])
  })

  test('keeps an app pattern that is not lower-case working', () => {
    // `initConfig` appends user patterns verbatim; folding only the path would
    // stop matching the very patterns the app wrote.
    const appGlob = new Bun.Glob('{**/Secrets.txt}')
    expect(matchBlocked(appGlob, '/Secrets.txt')).toBe(true)
  })

  test('an absent glob is not a match', () => {
    expect(matchBlocked(undefined, '/package.json')).toBe(false)
  })
})

describe('normalizeBlockedPath', () => {
  test('folds case', () => {
    expect(normalizeBlockedPath('/STYLES/Global.CSS')).toBe('/styles/global.css')
  })

  test('trims trailing dots and spaces per component', () => {
    expect(normalizeBlockedPath('/package.json.')).toBe('/package.json')
    expect(normalizeBlockedPath('/dir. /file.ts ')).toBe('/dir/file.ts')
  })

  test('leaves relative components intact', () => {
    // Trimming these would rewrite the segment into something else entirely;
    // containment is fs.isForbidden's job, not this function's.
    expect(normalizeBlockedPath('/a/./b')).toBe('/a/./b')
    expect(normalizeBlockedPath('/a/../b')).toBe('/a/../b')
    expect(normalizeBlockedPath('/a/.../b')).toBe('/a/.../b')
  })
})

describe('matchBlocked — NTFS alternate data streams', () => {
  /**
   * Win32 opens `x.ts::$DATA` as the bytes of `x.ts`, and `new URL()` keeps
   * the suffix in `pathname`. `normalizeBlockedPath` folded case and trailing
   * dots but left `:` alone, so every basename-anchored pattern was one
   * suffix away from being bypassed — verified against a live server:
   * `/schema.ts` 403, `/schema.ts::$DATA` 200 with the file's contents.
   * `::$INDEX_ALLOCATION` does the same for a *directory* segment, which
   * reaches the directory-scoped patterns the file form cannot.
   */
  const blocked = new Bun.Glob('{**/.env,**/*.db,**/schema.ts,**/private/**/*}')

  test('a stream suffix on the file does not launder it', () => {
    for (const p of [
      '/.env::$DATA',
      '/.env::$data',
      '/app.db::$DATA',
      '/schema.ts::$DATA',
    ]) {
      expect(matchBlocked(blocked, p)).toBe(true)
    }
  })

  test('a stream suffix on a directory segment does not either', () => {
    expect(matchBlocked(blocked, '/private::$INDEX_ALLOCATION/notes.txt')).toBe(
      true,
    )
  })

  test('an unblocked path with a colon is still served', () => {
    // Colons are legal in POSIX filenames; the suffix forms above are what
    // must be caught, not every colon.
    expect(matchBlocked(blocked, '/notes:draft.txt')).toBe(false)
  })

  test('a colon-bearing name whose real form is blocked stays blocked', () => {
    // Fail closed: matching the stripped form must never *unblock* something
    // the verbatim form already caught.
    expect(matchBlocked(blocked, '/a:b.db')).toBe(true)
  })
})
