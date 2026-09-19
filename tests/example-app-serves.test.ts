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
