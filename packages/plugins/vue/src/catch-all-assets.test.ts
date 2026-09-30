import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery, hostKey, hostStore } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  getConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { HandlerMap, StaticHandler } from '@bakery-framework/core/handlers'
import { handleRequest, processResponse } from '@bakery-framework/core/router'
import { fs, toHash } from '@bakery-framework/core/utils'
import { VueHandler } from './handler'

/**
 * A dynamic page's own stylesheet and root script are requested through the
 * page's URL, not through the component's file path.
 *
 * The page used to link both by file path, which for a catch-all is
 * `/admin/[...slug].vue`. A browser sends the brackets unencoded, and route
 * lookup reads a requested name as a glob, where `[...slug]` is a character
 * class: the literal file never matched, the catch-all yielded to the real file
 * of that name, and both requests answered 404. A real app's admin area loaded
 * with no styles and no script. Percent-encoded, the same file answered 200,
 * which is why a request typed by hand could look fine.
 *
 * Driven through the real router, with the registries swapped for private maps
 * the way `router.test.ts` does it, so the assertion is on what a browser gets
 * back for the exact URLs the page emits.
 */
const ROOT = fs.resolve(process.cwd(), '.cache', '__vue-catch-all-assets__')

const PAGE = [
  '<script setup lang="ts">',
  'const label = "admissions"',
  '</script>',
  '',
  '<template>',
  '  <h1 class="title">{{ label }}</h1>',
  '</template>',
  '',
  '<style>',
  '.title { color: teal; }',
  '</style>',
  '',
].join('\n')

const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  await initConfig()
  await Bun.write(`${ROOT}/admin/[...slug].vue`, PAGE)
  __setTestConfig({ root: ROOT } as any)

  const fetchMap = new HandlerMap()
  fetchMap.set(VueHandler, 58)
  fetchMap.set(StaticHandler, 0)
  registries.fetch = fetchMap
  registries.error = new HandlerMap<any>()
})

afterAll(() => {
  registries.fetch = original.fetch
  registries.error = original.error
  __resetTestConfig()
})

/** A request the way `cli/src/worker.ts` serves one: route it, then shape it. */
const get = (path: string) =>
  hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
    const req = new Request(`http://localhost${path}`)
    return (await processResponse(await handleRequest(req), req)) as Response
  })

describe("a catch-all page's own assets", () => {
  test('are linked through the page URL, never the bracketed file path', async () => {
    const res = await get('/admin/home')
    expect(res.status).toBe(200)
    const html = await res.text()

    expect(html).toContain('src="/admin/home?__vue_script=root"')
    expect(html).toContain('href="/admin/home?__vue_css=true"')
    expect(html).not.toContain('[...slug]')
  })

  test('both answer with the right content, which the file path did not', async () => {
    const html = await (await get('/admin/home')).text()
    const script = /src="([^"]+__vue_script=root)"/.exec(html)?.[1]
    const css = /href="([^"]+__vue_css=true)"/.exec(html)?.[1]
    expect(script).toBeDefined()
    expect(css).toBeDefined()

    const js = await get(script as string)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')

    const style = await get(css as string)
    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toContain('text/css')
    expect(await style.text()).toContain('teal')
  })

  test('the URL is escaped for the attribute it lands in', async () => {
    const file = `${ROOT}/admin/[...slug].vue`
    const parsed = await VueHandler.parseVueFile(
      toHash(hostKey('admin/[...slug].vue')),
      Bun.file(file),
      file,
      Bun.file(file).lastModified,
    )
    const res = await VueHandler.handleHtml(
      'esc-1',
      {},
      '/admin/[...slug].vue',
      undefined,
      parsed,
      undefined,
      '/admin/a&b"c',
    )
    const html = await (res as Response).text()
    expect(html).toContain('src="/admin/a&amp;b&quot;c?__vue_script=root"')
  })
})
