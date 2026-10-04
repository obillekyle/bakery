import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type AppServer, bootApp } from './support/serve-app'
import {
  removeVueApp,
  VUE_APP_GUARDED,
  VUE_APP_SERVER_PAGES,
  writeVueApp,
} from './support/vue-app'

/**
 * `bakery --build`, asked through a server booted in production.
 *
 * The same app is served unbuilt, then built, then built and out of date, and
 * each time its admin page is loaded the way a browser loads it: the shell,
 * then every script, preload and stylesheet it names, then every import those
 * scripts make, with bare specifiers resolved through the shell's import map.
 * What is counted is what a cold browser would fetch. The one thing the walk
 * cannot see is a fetch made by running code (the unbuilt page's stylesheet
 * import), so the unbuilt count is a floor.
 */
const PORT = 4604
const CLI = resolve(import.meta.dir, '../packages/cli/src/index.ts')

let app = ''

beforeAll(() => {
  app = writeVueApp('bakery-vue-build-')
})

afterAll(() => {
  if (app) removeVueApp(app)
})

type Walk = { requests: Map<string, number>; html: string }

/** Load `path` as a cold browser would, and report every request it makes. */
async function walk(base: string, path: string, headers = {}): Promise<Walk> {
  const requests = new Map<string, number>()
  const page = await fetch(base + path, { headers })
  const html = await page.text()
  requests.set(path, page.status)

  const imports = JSON.parse(
    html.match(/<script type="importmap">([^<]*)<\/script>/)?.[1] ?? '{}',
  ).imports as Record<string, string>
  const bare = (specifier: string): string | null => {
    if (imports[specifier]) return imports[specifier]
    for (const [key, target] of Object.entries(imports)) {
      if (key.endsWith('/') && specifier.startsWith(key)) {
        return target + specifier.slice(key.length)
      }
    }
    return null
  }

  // What a browser sends as `Sec-Fetch-Dest`, which the Vue handler reads: an
  // unbuilt component's URL carries no query in minified code, and the header
  // is what tells it from a page.
  const queue: { url: string; dest: 'script' | 'style' }[] = []
  for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) {
    queue.push({ url: m[1]!, dest: 'script' })
  }
  for (const m of html.matchAll(/<link([^>]*)\bhref="([^"]+)"/g)) {
    const dest = m[1]!.includes('stylesheet') ? 'style' : 'script'
    queue.push({ url: m[2]!, dest })
  }

  while (queue.length) {
    const { url, dest } = queue.shift()!
    if (requests.has(url)) continue
    const res = await fetch(base + url, {
      headers: { accept: '*/*', 'sec-fetch-dest': dest },
    })
    requests.set(url, res.status)
    const body = await res.text()
    if (!(res.headers.get('content-type') ?? '').includes('javascript'))
      continue

    for (const m of body.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g,
    )) {
      const specifier = m[1]!
      const next =
        specifier.startsWith('/') || specifier.startsWith('.')
          ? new URL(specifier, `http://x${url}`).pathname +
            new URL(specifier, `http://x${url}`).search
          : bare(specifier)
      if (next && !requests.has(next)) queue.push({ url: next, dest: 'script' })
    }
  }
  return { requests, html }
}

async function serve(run: (base: string) => Promise<void>) {
  const server: AppServer = await bootApp(app, PORT, { args: [] })
  try {
    await run(server.base)
  } finally {
    await server.stop()
  }
}

describe('Vue pages, built and not', () => {
  let unbuilt = 0

  test('unbuilt, the admin page costs a request per module', async () => {
    await serve(async base => {
      const { requests, html } = await walk(base, '/admin/x')
      expect(html).toContain('__vue_script=root')
      expect([...requests.values()].every(status => status === 200)).toBe(true)
      unbuilt = requests.size
      expect(unbuilt).toBeGreaterThanOrEqual(40)
    })
  }, 90_000)

  test('bakery --build bundles the pages', () => {
    const build = Bun.spawnSync(['bun', CLI, '--build'], {
      cwd: app,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(build.exitCode).toBe(0)
    expect(build.stdout.toString()).toContain('Built 2 pages')
  }, 90_000)

  test('built, it costs a handful, and renders the same data', async () => {
    await serve(async base => {
      const { requests, html } = await walk(base, '/admin/x')
      const urls = [...requests.keys()]

      expect([...requests.values()].every(status => status === 200)).toBe(true)
      expect(urls.some(url => url.includes('.vue'))).toBe(false)
      expect(html).toContain('rel="modulepreload"')
      expect(html).not.toContain('__vue_script')
      expect(requests.size).toBeLessThanOrEqual(8)
      expect(requests.size * 5).toBeLessThan(unbuilt)

      // Every server block the page reaches ran with the page request.
      const data = JSON.parse(
        html.match(
          /globalThis\.__vue_server_modules = ([^<]*);<\/script>/,
        )![1]!,
      ) as Record<string, unknown>
      expect(Object.keys(data)).toHaveLength(VUE_APP_SERVER_PAGES)
      expect(data[VUE_APP_GUARDED]).toEqual({ total: 600 })
    })
  }, 90_000)

  test('a block answering with a response is recorded for its component to throw on', async () => {
    await serve(async base => {
      const res = await fetch(`${base}/admin/x`, {
        headers: { 'x-test-role': 'guest' },
      })
      const html = await res.text()
      const data = JSON.parse(
        html.match(
          /globalThis\.__vue_server_modules = ([^<]*);<\/script>/,
        )![1]!,
      ) as Record<string, unknown>
      expect(data[VUE_APP_GUARDED]).toEqual({ __bakeryResponse: 401 })
    })
  }, 90_000)

  test('the build hands out its own files, for a year, and nothing else', async () => {
    await serve(async base => {
      const html = await (await fetch(`${base}/admin/x`)).text()
      const entry = html.match(/<script type="module" src="([^"]+)"/)![1]!
      const res = await fetch(base + entry)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      )

      // The manifest holds absolute paths of the app's files.
      for (const path of [
        '/_vue/build/manifest.json',
        '/_vue/build/p-notthere.js',
        '/_vue/build/../build/manifest.json',
        '/_vue/build/%2e%2e/manifest.json',
      ]) {
        expect((await fetch(base + path)).status).toBe(404)
      }
    })
  }, 90_000)

  test('a source changed after the build is served unbundled until the next build', async () => {
    appendFileSync(
      join(app, 'src/components/Widget3.vue'),
      '\n<!-- changed after the build -->\n',
    )
    await serve(async base => {
      const { requests, html } = await walk(base, '/admin/x')
      expect(html).toContain('__vue_script=root')
      expect([...requests.values()].every(status => status === 200)).toBe(true)
    })
  }, 90_000)
})
