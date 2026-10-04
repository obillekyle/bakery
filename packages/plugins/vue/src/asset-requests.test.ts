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
 * Which of a Vue page's requests are assets, the ones the rate limiter stops
 * counting once served (see `Handler.isAsset`).
 *
 * The line runs through one URL: a page answers its own address with HTML,
 * its stylesheet and its root script, and a component file answers with its
 * module script. Of those, only the ones that run no app code per request
 * are assets. A module whose component has a `<script server>` block runs
 * that block on every request, so counting it is the limiter doing its job.
 *
 * Driven through the real router, as `deep-imports.test.ts` is, and judged
 * the way the worker judges: the handler recorded on the request store,
 * asked after the response, with the status under 400.
 */
const ROOT = fs.resolve(process.cwd(), '.cache', '__vue-asset-requests__')

const HOME = [
  '<script server>',
  'export const count = 3',
  '</script>',
  '<script setup lang="ts">',
  "import Badge from './parts/badge.vue'",
  "import Stats from './parts/stats.vue'",
  '</script>',
  '<template><Badge /><Stats /></template>',
  '<style>p { color: rebeccapurple }</style>',
  '',
].join('\n')

const BADGE = [
  '<script setup lang="ts">',
  "const label = 'BADGE'",
  '</script>',
  '<template><span>{{ label }}</span></template>',
  '',
].join('\n')

const STATS = [
  '<script server>',
  'export const visits = 42',
  '</script>',
  '<template><p>stats</p></template>',
  '',
].join('\n')

const registries: { fetch: HandlerMap; error: HandlerMap<any> } =
  Bakery.handlers as any
const original = { fetch: registries.fetch, error: registries.error }

beforeAll(async () => {
  await initConfig()
  await Bun.write(`${ROOT}/home.vue`, HOME)
  await Bun.write(`${ROOT}/parts/badge.vue`, BADGE)
  await Bun.write(`${ROOT}/parts/stats.vue`, STATS)
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

/** Serve a request and say whether the worker would count it as an asset. */
const serve = (path: string, dest?: string) =>
  hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
    const req = new Request(`http://localhost${path}`, {
      headers: dest ? { 'sec-fetch-dest': dest } : {},
    })
    const res = (await processResponse(await handleRequest(req), req))!
    await res.arrayBuffer()
    const handler = hostStore.getStore()?.handler
    const asset =
      res.status < 400 &&
      Boolean(handler?.isAsset(new URL(req.url).pathname, req))
    return { status: res.status, asset }
  })

describe('a Vue page and its parts', () => {
  test('the stylesheet is an asset', async () => {
    expect(await serve('/home?__vue_css', 'style')).toEqual({
      status: 200,
      asset: true,
    })
  })

  test('the root script is an asset', async () => {
    expect(await serve('/home?__vue_script=root', 'script')).toEqual({
      status: 200,
      asset: true,
    })
  })

  test('a component with no server block is an asset as a module', async () => {
    expect(
      await serve('/parts/badge.vue?__vue_script=module', 'script'),
    ).toEqual({ status: 200, asset: true })
  })

  test('a component whose server block runs per request is not', async () => {
    expect(
      await serve('/parts/stats.vue?__vue_script=module', 'script'),
    ).toEqual({ status: 200, asset: false })
  })

  test('the page itself is not an asset', async () => {
    // A navigation runs the page's server block, and it is the request a
    // page view is counted by.
    expect(await serve('/home', 'document')).toEqual({
      status: 200,
      asset: false,
    })
  })

  test('a refused import is not an asset', async () => {
    // A script request that reached nothing it names answers 404, and a
    // status of 400 or more never proves an asset, whoever answered it.
    const res = await serve('/parts/missing.vue?__vue_script=module', 'script')
    expect(res.status).toBe(404)
    expect(res.asset).toBe(false)
  })
})
