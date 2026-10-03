import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { Bakery, hostStore } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  getConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import {
  HandlerMap,
  StaticHandler,
  TSHandler,
} from '@bakery-framework/core/handlers'
import { handleRequest, processResponse } from '@bakery-framework/core/router'
import { fs } from '@bakery-framework/core/utils'
import { VueHandler } from './handler'

/**
 * A page's imports reach the files they name, however deep the page's URL.
 *
 * 2.0.4 serves a dynamic page's root script at the page's own URL, and the
 * compiled script kept its imports relative. A browser resolves those against
 * the script's URL, so one segment deep (`/admin/faculty`) they landed where
 * the source file lives, by coincidence, and deeper (`/admin/faculty/add`)
 * they did not: `../shared/usePath` became `/admin/shared/usePath`. The
 * catch-all matched every such address and answered each with its own
 * script, which imported more wrong addresses in turn. Measured in a real
 * admin area: 49 modules for one load, the same files under two or three
 * URLs, rate-limit 429s, and 8 of 14 pages blank on a direct load.
 *
 * Driven through the real router with the three handlers a page needs, the
 * way `catch-all-assets.test.ts` does, and followed the way a browser follows
 * imports: each specifier resolved against the URL of the script it came from.
 *
 * Bracketed folders are not covered: discovery has never descended them
 * (routing.md), so no page can live in one.
 */
const ROOT = fs.resolve(process.cwd(), '.cache', '__vue-deep-imports__')

const CATCH_ALL = [
  '<script setup lang="ts">',
  "import { usePath } from '../shared/usePath'",
  "import Dashboard from './pages/dashboard.vue'",
  "const marker = 'CATCHALL-MARKER'",
  '</script>',
  '<template><Dashboard :p="usePath() + marker" /></template>',
  '',
].join('\n')

const DASHBOARD = [
  '<script setup lang="ts">',
  "const marker = 'DASHBOARD-MARKER'",
  '</script>',
  '<template><p>{{ marker }}</p></template>',
  '',
].join('\n')

const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  await initConfig()
  await Bun.write(`${ROOT}/admin/[...slug].vue`, CATCH_ALL)
  await Bun.write(`${ROOT}/admin/pages/dashboard.vue`, DASHBOARD)
  await Bun.write(
    `${ROOT}/shared/usePath.ts`,
    "export const usePath = () => 'USEPATH-MARKER'\n",
  )
  __setTestConfig({ root: ROOT } as any)

  const fetchMap = new HandlerMap()
  fetchMap.set(VueHandler, 58)
  fetchMap.set(TSHandler, 50)
  fetchMap.set(StaticHandler, 0)
  registries.fetch = fetchMap
  registries.error = new HandlerMap<any>()
})

afterAll(() => {
  registries.fetch = original.fetch
  registries.error = original.error
  __resetTestConfig()
  rmSync(ROOT, { recursive: true, force: true })
})

/** A request the way the worker serves one, with a script request's header. */
const get = (path: string, script = false) =>
  hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
    const req = new Request(`http://localhost${path}`, {
      headers: script ? { 'sec-fetch-dest': 'script' } : {},
    })
    return (await processResponse(await handleRequest(req), req)) as Response
  })

/** Which fixture a response's code came from. */
function whose(code: string): string[] {
  return ['CATCHALL', 'DASHBOARD', 'USEPATH'].filter(m =>
    code.includes(`${m}-MARKER`),
  )
}

/**
 * Load a page and follow its root script's imports one level, as a browser
 * would: each specifier resolved against the root script's URL.
 */
async function follow(page: string) {
  const html = await (await get(page)).text()
  const root = /src="([^"]+__vue_script=root)"/.exec(html)?.[1]
  if (!root) throw new Error(`${page} links no root script`)
  const code = await (await get(root, true)).text()
  const specifiers = [
    ...code.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
  ]
    .map(m => m[1] as string)
    .filter(s => s.startsWith('.') || s.startsWith('/'))
  const imports: { url: string; status: number; whose: string[] }[] = []
  for (const spec of specifiers) {
    const url = new URL(spec, `http://localhost${root}`)
    const target = url.pathname + url.search
    const res = await get(target, true)
    imports.push({ url: target, status: res.status, whose: whose(await res.text()) })
  }
  return { root, imports }
}

describe('a catch-all page at any depth', () => {
  for (const page of ['/admin/faculty', '/admin/faculty/add', '/admin/campus/3/faculty']) {
    test(`${page}: every import reaches the file it names`, async () => {
      const { imports } = await follow(page)
      expect(imports.map(i => i.whose)).toEqual([['USEPATH'], ['DASHBOARD']])
      for (const i of imports) expect(i.status).toBe(200)
    })
  }

  test('the import URLs are the same from every depth: one URL per file', async () => {
    const shallow = (await follow('/admin/faculty')).imports.map(i => i.url)
    const deep = (await follow('/admin/campus/3/faculty')).imports.map(i => i.url)
    expect(deep).toEqual(shallow)
    // Paths only: whether `?__vue_script=module` rides along depends on
    // whether the compiled code was minified, which this does not test.
    expect(shallow.map(u => u.split('?')[0])).toEqual([
      '/shared/usePath',
      '/admin/pages/dashboard.vue',
    ])
  })
})

describe('a script request a dynamic page only matched through its parameter', () => {
  // These are the addresses the old relative imports produced. Each one used
  // to answer 200 with the catch-all's own script, which is what hid the
  // whole defect: the browser saw JavaScript, never a 404.
  for (const wrong of [
    '/admin/faculty/pages/dashboard.vue?__vue_script=module',
    '/admin/shared/usePath',
  ]) {
    test(`${wrong} is refused, not answered with the catch-all's code`, async () => {
      const res = await get(wrong, true)
      expect(res.status).toBe(404)
      expect(whose(await res.text())).not.toContain('CATCHALL')
    })
  }

  test("the page itself and its own root script still answer at the page URL", async () => {
    const page = await get('/admin/faculty/add')
    expect(page.status).toBe(200)
    const root = await get('/admin/faculty/add?__vue_script=root', true)
    expect(root.status).toBe(200)
    expect(whose(await root.text())).toContain('CATCHALL')
  })
})
