import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { Bakery, hostStore } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  clearHostConfigCache,
  initConfig,
  resolveHostConfig,
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
 * A `defineLayout()` catch-all on a host that serves its directory at the
 * root (`hostMounts`), beside a host that serves the app as it is.
 *
 * Two things change on the mounted host, and nothing else may. The stamped
 * `base` loses the mount, so `defineLayout()` reads its segments from the bare
 * path and keeps soft navigation on `/data-table` links. And the page links
 * its stylesheet and root script by the URL the app knows it by,
 * `/kit/data-table`: those requests are not navigations, so the router serves
 * them from the app's root, where the address-bar spelling would name some
 * other page or none.
 */
const ROOT = fs.resolve(process.cwd(), '.cache', '__vue-host-mount__')

const KIT_PAGE = [
  '<script setup lang="ts">',
  "import { demo } from './useDemo'",
  "const label = 'kit docs ' + demo",
  '</script>',
  '',
  '<template>',
  '  <h1 class="kit">{{ label }}</h1>',
  '</template>',
  '',
  '<style>',
  '.kit { color: teal; }',
  '</style>',
  '',
].join('\n')

const FILES: Record<string, string> = {
  'kit/[...slug!].vue': KIT_PAGE,
  'kit/useDemo.ts': "export const demo = 'from the kit'\n",
  'index.vue': '<template><h1>root home</h1></template>\n',
  'ui/Button.vue': '<template><button class="ui">ok</button></template>\n',
}

const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  await initConfig()
  for (const [file, text] of Object.entries(FILES)) {
    await Bun.write(`${ROOT}/${file}`, text)
  }
  __setTestConfig({
    root: ROOT,
    hostMounts: [{ host: 'kit.*', path: '/kit' }],
  } as any)

  const fetchMap = new HandlerMap()
  fetchMap.set(VueHandler, 58)
  fetchMap.set(TSHandler, 50)
  fetchMap.set(StaticHandler, 0)
  registries.fetch = fetchMap
  registries.error = new HandlerMap<any>()
})

afterAll(async () => {
  registries.fetch = original.fetch
  registries.error = original.error
  __resetTestConfig()
  clearHostConfigCache()
  await initConfig()
  await rm(ROOT, { recursive: true, force: true })
})

const NAVIGATE = {
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
  accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
}
const SCRIPT = {
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'script',
  accept: '*/*',
}
const STYLE = {
  'sec-fetch-mode': 'no-cors',
  'sec-fetch-dest': 'style',
  accept: 'text/css,*/*;q=0.1',
}

/**
 * A request the way `cli/src/worker.ts` serves one: in its host's config,
 * routed, then shaped.
 */
const get = (host: string, path: string, headers: Record<string, string>) =>
  hostStore.run(
    { config: resolveHostConfig(host), hostname: host },
    async () => {
      const req = new Request(`http://${host}${path}`, { headers })
      return (await processResponse(await handleRequest(req), req)) as Response
    },
  )

/** The `defineLayout()` stamp a page carries. */
function stampedRoute(html: string): { base: string; catchAll: boolean } {
  const json = /globalThis\.__vue_route = (\{.*?\});<\/script>/.exec(html)?.[1]
  if (!json) throw new Error('the page carries no route stamp')
  return JSON.parse(json)
}

describe('a catch-all page on a host that serves its directory at the root', () => {
  test('stamps the base without the mount, so the layout reads the bare path', async () => {
    const res = await get('kit.localhost', '/data-table', NAVIGATE)
    expect(res.status).toBe(200)
    const route = stampedRoute(await res.text())
    expect(route.catchAll).toBe(true)
    expect(route.base).toBe('')
  })

  test('answers at the host root, which is the bare directory', async () => {
    const res = await get('kit.localhost', '/', NAVIGATE)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(stampedRoute(html).base).toBe('')
    expect(html).toContain('src="/kit?__vue_script=root"')
  })

  test('links its stylesheet and root script by the URL the app knows it by', async () => {
    const html = await (
      await get('kit.localhost', '/data-table', NAVIGATE)
    ).text()
    expect(html).toContain('src="/kit/data-table?__vue_script=root"')
    expect(html).toContain('href="/kit/data-table?__vue_css=true"')
  })

  test('and both answer there, on the same host, with this page', async () => {
    const script = await get(
      'kit.localhost',
      '/kit/data-table?__vue_script=root',
      SCRIPT,
    )
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toContain('kit docs ')

    const css = await get(
      'kit.localhost',
      '/kit/data-table?__vue_css=true',
      STYLE,
    )
    expect(css.status).toBe(200)
    expect(await css.text()).toContain('.kit')
  })

  test('the modules it imports come from the app root, an extensionless one too', async () => {
    const own = await get('kit.localhost', '/kit/useDemo', SCRIPT)
    expect(own.status).toBe(200)
    expect(await own.text()).toContain('from the kit')

    const shared = await get(
      'kit.localhost',
      '/ui/Button.vue?__vue_script=module',
      SCRIPT,
    )
    expect(shared.status).toBe(200)
    expect(shared.headers.get('content-type')).toContain('javascript')
  })
})

describe('the same page on a host no mount serves', () => {
  test('keeps its directory as the base and its own URL for its assets', async () => {
    const res = await get('admin.localhost', '/kit/data-table', NAVIGATE)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(stampedRoute(html).base).toBe('/kit')
    expect(html).toContain('src="/kit/data-table?__vue_script=root"')
  })

  test('and that host root is the app root', async () => {
    const res = await get('admin.localhost', '/', NAVIGATE)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('src="/?__vue_script=root"')
    expect(stampedRoute(html).catchAll).toBe(false)
  })
})

describe("the same page under a hosts entry's mount", () => {
  beforeAll(async () => {
    clearHostConfigCache()
    await initConfig()
    __setTestConfig({
      root: ROOT,
      domains: 'bpc.edu.ph',
      hosts: { kit: { mount: '/kit' } },
    } as any)
  })

  test('is stamped and linked the way the hostMounts form does it', async () => {
    for (const host of ['kit.bpc.edu.ph', 'kit.localhost']) {
      const res = await get(host, '/data-table', NAVIGATE)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(`${host}: ${stampedRoute(html).base}`).toBe(`${host}: `)
      expect(html).toContain('src="/kit/data-table?__vue_script=root"')
    }
    const script = await get(
      'kit.bpc.edu.ph',
      '/kit/data-table?__vue_script=root',
      SCRIPT,
    )
    expect(script.status).toBe(200)
    expect(await script.text()).toContain('kit docs ')
  })
})
