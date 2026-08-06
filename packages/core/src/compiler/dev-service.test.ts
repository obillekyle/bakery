import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../core/config'
import { fs } from '../utils/fs'
import {
  classifySchemaSync,
  classifyWatchEvent,
  isBackendPriorityFile,
} from './dev-service'

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetTestConfig()
})

/**
 * `prioFilesGlob` carried `'api/**\/*'` from before API routes moved under
 * `<root>/api`. With the default `root: 'src'` that pattern matched nothing, so
 * editing an API route never restarted the backend. The route file itself still
 * reloaded through the `?v=<mtime>` cache-buster, which hid it: only the
 * route's *imports* went stale.
 */
describe('isBackendPriorityFile', () => {
  test('matches API routes where they actually live', () => {
    expect(isBackendPriorityFile('src/api/users.ts')).toBe(true)
    expect(isBackendPriorityFile('src/api/nested/[id].ts')).toBe(true)
    expect(isBackendPriorityFile('src/api')).toBe(true)
  })

  test('does not match a root-level api/ directory', () => {
    expect(isBackendPriorityFile('api/users.ts')).toBe(false)
  })

  test('follows a configured root instead of hard-coding one', () => {
    __setTestConfig({ root: fs.resolve('backend') })

    expect(isBackendPriorityFile('backend/api/users.ts')).toBe(true)
    expect(isBackendPriorityFile('src/api/users.ts')).toBe(false)
  })

  test('is not fooled by a prefix collision', () => {
    expect(isBackendPriorityFile('src/apiary/bees.ts')).toBe(false)
    expect(isBackendPriorityFile('src/api-docs/index.ts')).toBe(false)
  })

  test('still matches server.config.ts', () => {
    expect(isBackendPriorityFile('server.config.ts')).toBe(true)
  })

  /**
   * `.tsx` used to be a priority pattern: route modules are cached by Bun's
   * registry, so without a restart an edited page served stale. TSXHandler now
   * busts that cache with `?v=<mtime>` the same way ApiHandler does, so a page
   * edit takes the cheap path (route-cache flush + browser reload) instead of
   * a full process restart with config/plugin/import-map re-init.
   */
  test('tsx pages take the cheap path, not a restart', () => {
    expect(isBackendPriorityFile('src/pages/index.tsx')).toBe(false)
    expect(isBackendPriorityFile('src/index.tsx')).toBe(false)
  })

  test('leaves ordinary sources to livereload', () => {
    expect(isBackendPriorityFile('src/lib/format.ts')).toBe(false)
    expect(isBackendPriorityFile('src/styles/global.css')).toBe(false)
  })
})

/**
 * The package branch in `startCompileService` sat *after* a filter that only
 * admitted `{css,html,ts,js,tsx,jsx,vue}`, so `package.json` was dropped before
 * it could ever be reached: editing it in dev produced no log line at all.
 */
describe('classifyWatchEvent', () => {
  test('classifies package manifests before the extension filter', () => {
    expect(classifyWatchEvent('package.json')).toBe('package')
    expect(classifyWatchEvent('bun.lock')).toBe('package')
    expect(classifyWatchEvent('bun.lockb')).toBe('package')
  })

  test('ignore rules still win over the package branch', () => {
    expect(classifyWatchEvent('node_modules/left-pad/package.json')).toBe(
      'ignored',
    )
  })

  test('watched source files are ordinary events', () => {
    expect(classifyWatchEvent('src/index.ts')).toBe('file')
    expect(classifyWatchEvent('src/App.vue')).toBe('file')
    expect(classifyWatchEvent('src/styles/global.css')).toBe('file')
  })

  test('unwatched extensions are ignored', () => {
    expect(classifyWatchEvent('README.md')).toBe('ignored')
    expect(classifyWatchEvent('public/logo.png')).toBe('ignored')
  })

  test('honours the ignore list', () => {
    expect(classifyWatchEvent('schema.ts')).toBe('ignored')
    expect(classifyWatchEvent('.bakery/cache/x.ts')).toBe('ignored')
  })

  /**
   * `.data/backups/` receives `schema.<timestamp>.ts` DB backup files at
   * runtime. Each write matched the `.ts` glob, so taking a backup while the
   * dev server ran flushed the route cache and reloaded the browser.
   */
  test('ignores the .data directory', () => {
    expect(classifyWatchEvent('.data/backups/schema.1722902400000.ts')).toBe(
      'ignored',
    )
    expect(classifyWatchEvent('.data/server.db')).toBe('ignored')
  })

  test('ignores schema.ts anywhere in the tree, not just at the root', () => {
    expect(classifyWatchEvent('orm/schema.ts')).toBe('ignored')
    expect(classifyWatchEvent('src/db/schema.ts')).toBe('ignored')
  })

  test('does not over-match files merely resembling schema.ts', () => {
    expect(classifyWatchEvent('src/schemas.ts')).toBe('file')
    expect(classifyWatchEvent('src/my-schema.ts')).toBe('file')
  })
})

/**
 * Every dev-worker boot used to run a full ORM schema sync, which dominated
 * restart time. The worker now hashes the schema sources before syncing and
 * skips the sync when nothing changed since the last *successful* one. The
 * decision is pure so every branch — and especially the fail-closed ones — is
 * pinned here.
 */
describe('classifySchemaSync', () => {
  const base = {
    force: false,
    currentHash: 'abc',
    storedHash: 'abc',
    dbMissing: false,
  }

  test('skips when the schema hash matches the recorded one', () => {
    expect(classifySchemaSync(base)).toBe('skip')
  })

  test('syncs when the schema changed', () => {
    expect(classifySchemaSync({ ...base, storedHash: 'old' })).toBe('sync')
  })

  test('--sync forces a sync even when nothing changed', () => {
    expect(classifySchemaSync({ ...base, force: true })).toBe('sync')
  })

  test('syncs when no successful sync was ever recorded', () => {
    expect(classifySchemaSync({ ...base, storedHash: null })).toBe('sync')
  })

  test('fails closed when the current hash cannot be computed', () => {
    // `null` means the schema sources could not be read/resolved — an
    // indeterminate state must re-sync, never silently skip (convention 2's
    // fail-closed clause, applied to a non-guard).
    expect(classifySchemaSync({ ...base, currentHash: null })).toBe('sync')
  })

  test('syncs when the database file is missing', () => {
    // Deleting .data/ to reset is a normal dev move; an unchanged schema hash
    // must not leave the app running against no database.
    expect(classifySchemaSync({ ...base, dbMissing: true })).toBe('sync')
  })
})
