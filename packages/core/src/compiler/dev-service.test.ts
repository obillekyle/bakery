import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../core/config'
import { fs } from '../utils/fs'
import {
  classifyDevError,
  classifySchemaSync,
  classifyWatchEvent,
  isCreatedRouteModule,
  createDevErrorPlugin,
  DEV_ERROR_PLUGIN,
  emitDevError,
  formatDevErrorFrame,
  isBackendPriorityFile,
  MAX_DEV_ERROR_BODY,
  notifyError,
  notifySockets,
  registerDevErrorOverlay,
  setDevErrorSink,
} from './dev-service'

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetTestConfig()
  setDevErrorSink(null)
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

/**
 * The dev error overlay was unreachable in practice. `notifyError` — the only
 * producer of the `{type:'error'}` frame `client/livereload.ts` renders — had
 * exactly one caller in non-test source: the `catch` around `processFileEvent`
 * in the watcher loop, which can only fire on an internal/IO fault.
 *
 * Every failure a developer actually hits (route syntax error, TSX render
 * throw, client TS compile failure, missing import) travels `handleRequestError`
 * instead, and nothing on that path published to the livereload topic. What
 * follows pins the seam that closed the gap: `ServerPlugin.onError`, which
 * `handleRequestError` calls first, feeding a module-level sink that the
 * compiler fills in with the live server.
 */
describe('classifyDevError', () => {
  test('5xx earns the overlay', () => {
    expect(classifyDevError({ errorCode: 500 })).toBe('overlay')
    expect(classifyDevError({ errorCode: 502 })).toBe('overlay')
    expect(classifyDevError({ errorCode: 599 })).toBe('overlay')
  })

  /**
   * A 404 for a mistyped URL or an absent favicon is the router working. An
   * overlay for it would be dismissed reflexively, which is how the feature
   * dies a second time.
   */
  test('4xx does not', () => {
    expect(classifyDevError({ errorCode: 404 })).toBe('ignore')
    expect(classifyDevError({ errorCode: 403 })).toBe('ignore')
    expect(classifyDevError({ errorCode: 499 })).toBe('ignore')
  })

  test('a record with no usable code is treated as a server error', () => {
    // `extractErrorData` fills errorCode on every path it owns, so arriving
    // without one means a malformed record — surface it, do not swallow it.
    expect(classifyDevError({})).toBe('overlay')
    expect(classifyDevError(undefined)).toBe('overlay')
    expect(classifyDevError({ errorCode: '500' } as any)).toBe('overlay')
  })
})

describe('formatDevErrorFrame', () => {
  const err = {
    errorCode: 500,
    errorText: 'Unexpected token',
    errorBody: 'SyntaxError: Unexpected token\n  at src/broken.tsx:3',
  }

  test('names the failing request in the title', () => {
    const frame = formatDevErrorFrame(err, {
      url: 'http://localhost:3284/broken',
    })
    expect(frame.title).toBe('500 Unexpected token — /broken')
    expect(frame.body).toBe(err.errorBody)
  })

  /**
   * `handleRequestError` substitutes `http://localhost/__internal__` when it
   * has no request. That names nothing the developer can act on, so it must
   * not be reported as if it were a route.
   */
  test('omits the synthetic internal request path', () => {
    const frame = formatDevErrorFrame(err, {
      url: 'http://localhost/__internal__',
    })
    expect(frame.title).toBe('500 Unexpected token')
  })

  test('survives a missing or unparseable request', () => {
    expect(formatDevErrorFrame(err).title).toBe('500 Unexpected token')
    expect(formatDevErrorFrame(err, { url: 'not a url' }).title).toBe(
      '500 Unexpected token',
    )
  })

  test('falls back to a usable title and an empty body', () => {
    const frame = formatDevErrorFrame({})
    expect(frame.title).toBe('500 Internal Server Error')
    expect(frame.body).toBe('')
  })

  /**
   * A framework-deep stack runs to tens of kilobytes, and this frame is
   * broadcast to every connected tab on every failing request.
   */
  test('truncates a runaway body', () => {
    const frame = formatDevErrorFrame({
      errorCode: 500,
      errorText: 'boom',
      errorBody: 'x'.repeat(MAX_DEV_ERROR_BODY + 500),
    })
    expect(frame.body.length).toBeLessThan(MAX_DEV_ERROR_BODY + 100)
    expect(frame.body.endsWith('… truncated')).toBe(true)
  })
})

/**
 * The sink is the whole point of the seam: the error path emits through it with
 * no knowledge of the compiler, and the compiler fills it in with the live
 * `Bun.Server`. Everywhere that is not a dev worker it stays unset, and
 * emitting must then cost nothing and throw nothing.
 */
describe('dev error sink', () => {
  test('emitting with no sink installed is a silent no-op', () => {
    expect(() => emitDevError('title', 'body')).not.toThrow()
  })

  test('an installed sink receives the frame', () => {
    const seen: [string, string][] = []
    setDevErrorSink((title, body) => void seen.push([title, body]))

    emitDevError('500 boom', 'stack')
    expect(seen).toEqual([['500 boom', 'stack']])
  })

  test('clearing the sink returns emitting to a no-op', () => {
    const seen: string[] = []
    setDevErrorSink(title => void seen.push(title))
    emitDevError('first', '')
    setDevErrorSink(null)
    emitDevError('second', '')

    expect(seen).toEqual(['first'])
  })
})

describe('createDevErrorPlugin', () => {
  test('publishes a 5xx through the sink', () => {
    const seen: [string, string][] = []
    setDevErrorSink((title, body) => void seen.push([title, body]))

    createDevErrorPlugin().onError!(
      { errorCode: 500, errorText: 'boom', errorBody: 'stack' },
      { url: 'http://localhost:3284/page' } as Request,
    )

    expect(seen).toEqual([['500 boom — /page', 'stack']])
  })

  test('stays quiet for a 4xx', () => {
    const seen: string[] = []
    setDevErrorSink(title => void seen.push(title))

    createDevErrorPlugin().onError!({
      errorCode: 404,
      errorText: 'Not Found',
      errorBody: '',
    })

    expect(seen).toEqual([])
  })

  /**
   * `PluginHooks.onError` returns the first plugin response it gets and stops.
   * This plugin observes only — anything but a nullish return would replace the
   * app's error page with the overlay plugin's answer.
   */
  test('never answers the request', () => {
    setDevErrorSink(() => {})
    const plugin = createDevErrorPlugin()

    expect(
      plugin.onError!({ errorCode: 500, errorText: 'a', errorBody: 'b' }),
    ).toBeUndefined()
    expect(
      plugin.onError!({ errorCode: 404, errorText: 'a', errorBody: 'b' }),
    ).toBeUndefined()
  })
})

describe('registerDevErrorOverlay', () => {
  /**
   * Front of the list, not the back: `PluginHooks.onError` stops at the first
   * plugin that answers, so an app plugin that renders its own error response
   * would otherwise hide every failure from the overlay.
   */
  test('registers ahead of the app plugins', () => {
    const plugins: any[] = [{ name: 'app-plugin' }]

    expect(registerDevErrorOverlay(plugins)).toBe('registered')
    expect(plugins.map(p => p.name)).toEqual([DEV_ERROR_PLUGIN, 'app-plugin'])
  })

  test('is idempotent — a second registration would double every frame', () => {
    const plugins: any[] = []

    expect(registerDevErrorOverlay(plugins)).toBe('registered')
    expect(registerDevErrorOverlay(plugins)).toBe('duplicate')
    expect(plugins).toHaveLength(1)
  })

  test('reports unavailable rather than throwing on a hostile list', () => {
    // Not `undefined` — that is the default-parameter path, covered below.
    expect(registerDevErrorOverlay(null)).toBe('unavailable')
    expect(registerDevErrorOverlay('nope')).toBe('unavailable')
    expect(registerDevErrorOverlay({ length: 1 })).toBe('unavailable')
    // A config is entitled to hand over a frozen array. That is a reason to
    // skip the overlay, not to take the dev server down.
    expect(registerDevErrorOverlay(Object.freeze([]))).toBe('unavailable')
  })

  test('defaults to the resolved config, which every host shares', () => {
    const plugins: any[] = [{ name: 'app-plugin' }]
    __setTestConfig({ plugins })

    expect(registerDevErrorOverlay()).toBe('registered')
    expect(plugins[0].name).toBe(DEV_ERROR_PLUGIN)
  })
})

/**
 * The two frame shapes share one topic and are told apart client-side by a
 * leading `{` (client/livereload.ts `ws.onmessage`). If a reload frame could
 * ever start with a brace the client would parse it as JSON and drop the
 * reload, so the discriminator is pinned here on the producing side.
 */
describe('livereload frame shapes', () => {
  function fakeServer() {
    const sent: string[] = []
    return {
      sent,
      publish: (_topic: string, msg: string) => void sent.push(msg),
    }
  }

  test('notifyError sends parseable JSON the overlay branch accepts', () => {
    const server = fakeServer()
    notifyError(server, 'Dev watcher error', 'EPERM: operation not permitted')

    expect(server.sent).toHaveLength(1)
    expect(server.sent[0].startsWith('{')).toBe(true)
    expect(JSON.parse(server.sent[0])).toEqual({
      type: 'error',
      title: 'Dev watcher error',
      body: 'EPERM: operation not permitted',
    })
  })

  test('a reload frame is a bare path and can never look like JSON', () => {
    const server = fakeServer()
    __setTestConfig({ root: fs.resolve('src') })
    notifySockets(server, fs.resolve('src/pages/index.tsx'))

    expect(server.sent).toEqual(['pages/index.tsx'])
    expect(server.sent[0].startsWith('{')).toBe(false)
  })

  test('publishing with no server at all is a no-op', () => {
    expect(() => notifyError(null, 'title', 'body')).not.toThrow()
    expect(() => notifyError(undefined, 'title', 'body')).not.toThrow()
  })
})

describe('isCreatedRouteModule', () => {
  test('a created .tsx page needs a restart', () => {
    expect(isCreatedRouteModule('src/new-page.tsx', 'rename', true)).toBe(true)
    expect(isCreatedRouteModule('src/new-page.jsx', 'rename', true)).toBe(true)
  })

  test('an edited page does not — that is the fast path', () => {
    // Measured on Windows: an in-place write emits only `change`.
    expect(isCreatedRouteModule('src/page.tsx', 'change', true)).toBe(false)
  })

  test('a deleted page does not', () => {
    // `rename` fires on delete too; there is nothing to import.
    expect(isCreatedRouteModule('src/gone.tsx', 'rename', false)).toBe(false)
  })

  test('non-imported file types are untouched', () => {
    // Read or transpiled from disk, never `import()`ed, so no resolver cache.
    for (const f of ['src/a.html', 'src/a.css', 'src/script/a.ts']) {
      expect(isCreatedRouteModule(f, 'rename', true)).toBe(false)
    }
  })
})
