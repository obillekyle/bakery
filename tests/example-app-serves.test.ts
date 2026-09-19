import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Every page the example app ships is requested, and none of them may 500.
 *
 * CLAUDE.md has recorded since the workspace split that "booted meant the
 * process started, not that anything was served" — every `.tsx` page in
 * `apps/starter` returned 500 for an unknown stretch while both gates stayed
 * green. That lesson was written down and then not acted on: no workflow boots
 * either app, and nothing in the suite requests a page.
 *
 * So it happened again, in the other app. `d13e57f` made a catch-all bind its
 * segments as an **array**, and `apps/example/src/wiki/[...page].tsx` kept
 * calling `body.page.split('/')`. Every request to it answered 500 — a shipped
 * page in the repo's own reference app, through an alpha line and twelve
 * releases, with a green suite and a green typecheck the whole way. `tsc`
 * cannot see it because the page's `body` is typed by what the page itself
 * declares, and that declaration was the thing that was wrong.
 *
 * **The assertion is "nothing 5xx", not "everything 200".** A route this walk
 * maps badly — `Layout.tsx` is a component, not a page — answers 404, and a
 * 404 is a correct answer to a request for something that is not there. To
 * stop the whole thing passing by 404ing uniformly, a handful of routes known
 * to exist are asserted at 200 as well.
 */

const APP = resolve(import.meta.dir, '../apps/example')
const CLI = resolve(import.meta.dir, '../packages/cli/src/index.ts')
// Not 3000: that port belongs to something else on the maintainer's machine.
const PORT = 4600
const BASE = `http://127.0.0.1:${PORT}`

let server: ReturnType<typeof Bun.spawn> | null = null

/** Route files, mapped to a URL by the documented rules. */
function discoverRoutes(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...discoverRoutes(full, `${prefix}/${entry}`))
      continue
    }
    const m = entry.match(/^(.*)\.(tsx|jsx|ts|css)$/)
    if (!m) continue
    const [, stem, ext] = m as unknown as [string, string, string]

    if (ext === 'css') {
      out.push(`${prefix}/${entry}`)
      continue
    }
    if (stem === 'index') out.push(prefix || '/')
    else if (stem.startsWith('[...')) out.push(`${prefix}/deep/nested/path`)
    else if (stem.startsWith('[')) out.push(`${prefix}/42`)
    else out.push(`${prefix}/${stem}`)
  }
  return out
}

beforeAll(async () => {
  server = Bun.spawn(['bun', CLI], {
    cwd: APP,
    env: { ...process.env, PORT: String(PORT) },
    stdout: 'ignore',
    stderr: 'ignore',
  })

  const deadline = Date.now() + 60_000
  for (;;) {
    if (Date.now() > deadline) throw new Error('the example app never answered')
    try {
      await fetch(`${BASE}/`)
      return
    } catch {
      // Not listening yet. A connection refusal here is the ordinary state
      // during boot, which is why it is the one swallowed exception in this
      // file.
      await Bun.sleep(250)
    }
  }
}, 90_000)

afterAll(() => {
  server?.kill()
})

describe('the example app serves what it ships', () => {
  test('no route answers 5xx', async () => {
    const routes = discoverRoutes(join(APP, 'src'))
    expect(routes.length).toBeGreaterThan(5)

    const failures: string[] = []
    for (const route of routes) {
      const res = await fetch(BASE + route)
      await res.arrayBuffer()
      if (res.status >= 500) failures.push(`${route} -> ${res.status}`)
    }
    expect(failures).toEqual([])
  }, 60_000)

  test('the pages that should render, do', async () => {
    // Without this the test above passes on an app that 404s uniformly.
    for (const route of ['/', '/jsx', '/wiki/a/b/c', '/api/hello']) {
      const res = await fetch(BASE + route)
      await res.arrayBuffer()
      expect(`${route} -> ${res.status}`).toBe(`${route} -> 200`)
    }
  }, 30_000)
})

/**
 * The console, requested rather than assumed, in **production**.
 *
 * This server boots without `--dev`, which is the whole point. Three separate
 * defects shipped in two days that were invisible to every other gate because
 * a development server takes a different branch:
 *
 *   - the client bundle kept a bare `import` of another package, so the whole
 *     script failed to parse and nothing on the page ran. Development returns
 *     the bundle as a *string*, which is a different code path entirely;
 *   - the cached bundle was wrapped in a `Response`, losing its ETag and
 *     Cache-Control, so the console re-downloaded 22 KB on every load.
 *     Development never takes the cached branch at all;
 *   - the Logs panel connected to `/_livereload`, which is registered only
 *     under `DEV`, so it answered 400 and the panel never received a line.
 *
 * The suite was green for all three. The typecheck was green for all three. CI
 * was green for all three. Each was found by opening the page by hand.
 */
describe('the console works in production', () => {
  test('its client bundle parses, which means no bare import survived', async () => {
    const res = await fetch(`${BASE}/_dashboard/dashboard.js`)
    const body = await res.text()
    expect(res.status).toBe(200)

    // `bundleModule` marks installed packages external, so a cross-package
    // specifier survives as a top-level `import`. That is correct for the
    // `/_nm/` bundles, which load as modules — and fatal here, because this is
    // served as a classic `<script>` where an import map does not apply and a
    // top-level `import` is a syntax error that takes the entire file down.
    const bare = body.match(/^import\s[^\n]*?from\s*['"]([^'"]+)['"]/m)
    expect(bare?.[1] ?? null).toBe(null)
  }, 30_000)

  test('the cached bundle keeps its ETag and answers a conditional request', async () => {
    // The *second* request is the one that matters: the first returns the
    // freshly written file and the second takes the cached branch, which is
    // where the ETag was being lost.
    await fetch(`${BASE}/_dashboard/dashboard.js`).then(r => r.arrayBuffer())

    const res = await fetch(`${BASE}/_dashboard/dashboard.js`)
    await res.arrayBuffer()
    const etag = res.headers.get('ETag')
    expect(etag).not.toBeNull()
    expect(res.headers.get('Cache-Control')).not.toBeNull()

    const conditional = await fetch(`${BASE}/_dashboard/dashboard.js`, {
      headers: { 'If-None-Match': etag! },
    })
    await conditional.arrayBuffer()
    expect(conditional.status).toBe(304)
  }, 30_000)

  test('the log socket accepts an upgrade and delivers a server line', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_dashboard/logs`)

    const outcome = await new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve('nothing arrived'), 10_000)
      ws.onopen = () => {
        // Something the server is guaranteed to log. A 404 is a warn line.
        void fetch(`${BASE}/definitely-not-a-route-${Date.now()}`)
          .then(r => r.arrayBuffer())
          .catch(() => {})
      }
      ws.onmessage = event => {
        try {
          if (JSON.parse(String(event.data)).type === 'server_log') {
            clearTimeout(timer)
            resolve('server_log')
          }
        } catch {
          // A frame that is not JSON is not the one being waited for, and the
          // timeout above is what ends this either way.
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        resolve('upgrade refused')
      }
      ws.onclose = event => {
        clearTimeout(timer)
        resolve(`closed ${event.code}`)
      }
    })

    try {
      ws.close()
    } catch {
      // Already closed by the branch that resolved above.
    }
    expect(outcome).toBe('server_log')
  }, 40_000)
})
