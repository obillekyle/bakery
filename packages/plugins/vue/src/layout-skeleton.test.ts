import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hostKey } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { fs, toHash } from '@bakery-framework/core/utils'
import { defineLayout, isUnderBase, segmentsUnder } from './client'
import { compileVueFile } from './compile'
import { VueHandler } from './handler'
import { parseSkeleton } from './utils'

const ROOT = fs.resolve(process.cwd(), '.cache', '__vue-layout-test__')

const write = (rel: string, content: string) =>
  Bun.write(`${ROOT}/${rel}`, content)

const PAGE = [
  '<script setup lang="ts">',
  'const label = "shipments"',
  '</script>',
  '',
  '<template>',
  '  <h1>{{ label }}</h1>',
  '</template>',
  '',
].join('\n')

const LAYOUT = [
  '<template>',
  '  <div class="chrome"><slot /></div>',
  '</template>',
  '',
  '<style>',
  '.chrome { padding: 1rem; }',
  '</style>',
  '',
].join('\n')

async function parse(rel: string) {
  const file = `${ROOT}/${rel}`
  return await VueHandler.parseVueFile(
    toHash(hostKey(rel)),
    Bun.file(file),
    file,
    Bun.file(file).lastModified,
  )
}

beforeAll(async () => {
  await initConfig()
  await write('site/layout.vue', LAYOUT)
  await write('site/reports.vue', PAGE)
  await write('site/admin/[...slug!].vue', PAGE)
  await write('site/bare.vue', `<meta no-layout />\n${PAGE}`)
  await write('lone/about.vue', PAGE)
  await write(
    'site/loading.vue',
    [
      '<template skeleton>',
      '  <div class="pulse">loading shipments…</div>',
      '</template>',
      '',
      PAGE,
    ].join('\n'),
  )
  __setTestConfig({ root: ROOT } as any)
})

afterAll(() => {
  __resetTestConfig()
})

describe('parseSkeleton', () => {
  test('extracts the block and removes it from the SFC', () => {
    const raw =
      '<template skeleton>\n <p>wait</p>\n</template>\n<template><div /></template>'
    const { skeleton, clean } = parseSkeleton(raw)
    expect(skeleton).toBe('<p>wait</p>')
    expect(clean).not.toContain('skeleton')
    expect(clean).toContain('<template><div /></template>')
  })

  test('tolerates extra attributes and no block at all', () => {
    expect(
      parseSkeleton('<template skeleton data-x="1"><i/></template>').skeleton,
    ).toBe('<i/>')
    expect(parseSkeleton('<template><div /></template>').skeleton).toBeNull()
  })
})

describe('skeleton through the pipeline', () => {
  test('parseVueFile strips the block and keeps its markup', async () => {
    const parsed = await parse('site/loading.vue')
    expect(parsed.skeleton).toContain('loading shipments…')
    expect(parsed.cleanContent).not.toContain('skeleton')

    // The remaining SFC still has exactly one template and compiles clean.
    const compiled = await compileVueFile({
      content: parsed.cleanContent,
      filename: 'loading.vue',
      id: 'sk-1',
      isRootScript: false,
    })
    expect(compiled.errors).toEqual([])
  })

  test('handleHtml puts the markup inside #app', async () => {
    const parsed = await parse('site/loading.vue')
    const res = await VueHandler.handleHtml(
      'sk-2',
      {},
      '/site/loading.vue',
      undefined,
      parsed,
    )
    const html = await (res as Response).text()
    expect(html).toContain('<div id="app">')
    expect(html).toContain('loading shipments…')
  })
})

describe('layout discovery', () => {
  test('a page finds the nearest layout above it', async () => {
    const parsed = await parse('site/reports.vue')
    expect(parsed.layoutRoute).toBe('/site/layout.vue')
  })

  test('a catch-all page is anchored by its file, not the URL', async () => {
    const parsed = await parse('site/admin/[...slug!].vue')
    expect(parsed.layoutRoute).toBe('/site/layout.vue')
  })

  test('<meta no-layout /> opts out', async () => {
    const parsed = await parse('site/bare.vue')
    expect(parsed.meta.layout).toBe(false)
    expect(parsed.layoutRoute).toBeNull()
  })

  test('no layout above means none', async () => {
    const parsed = await parse('lone/about.vue')
    expect(parsed.layoutRoute).toBeNull()
  })

  test('a layout never wraps itself', async () => {
    const parsed = await parse('site/layout.vue')
    expect(parsed.layoutRoute).toBeNull()
  })
})

describe('root emission with a layout', () => {
  test('the root renders the page into the layout slot', async () => {
    const compiled = await compileVueFile({
      content: PAGE,
      filename: 'reports.vue',
      id: 'ly-1',
      isRootScript: true,
      layoutRoute: '/site/layout.vue',
    })
    expect(compiled.errors).toEqual([])
    expect(compiled.code).toContain('import __layout from "/site/layout.vue"')
    expect(compiled.code).toContain('__h(__layout, null, { default:')
    expect(compiled.code).toContain("mount('#app')")
  })

  test('without a layout the root is unchanged', async () => {
    const compiled = await compileVueFile({
      content: PAGE,
      filename: 'reports.vue',
      id: 'ly-2',
      isRootScript: true,
      layoutRoute: null,
    })
    expect(compiled.code).toContain('createApp(__sfc__)')
    expect(compiled.code).not.toContain('__layout')
  })
})

/**
 * A server block with no `<script setup>` used to render blank — the injected
 * data block has no `export default`, so `assembleComponent` never declared
 * `__sfc__` and the module threw on load. The empty setup block that was the
 * documented workaround is injected automatically now. A layout is the shape
 * most likely to hit this: pure template plus a server block for shared data.
 */
describe('a server block without <script setup>', () => {
  test('compiles to a module that declares its component', async () => {
    await write(
      'site/counter.vue',
      [
        '<script server>',
        'export const shelfCount = 12',
        '</script>',
        '',
        '<template>',
        '  <p>{{ shelfCount }}</p>',
        '</template>',
        '',
      ].join('\n'),
    )

    const parsed = await parse('site/counter.vue')
    const compiled = await compileVueFile({
      content: parsed.cleanContent,
      filename: 'counter.vue',
      id: 'ns-1',
      isRootScript: false,
    })

    expect(compiled.errors).toEqual([])
    expect(compiled.code).toContain('const __sfc__')
    // The render function must reach the binding through the component, not a
    // bare identifier that would be a ReferenceError at runtime.
    expect(compiled.code).toMatch(/\$setup\.shelfCount|_ctx\.shelfCount/)
  })
})

/**
 * `defineLayout()` — the catch-all guard and the pure path helpers. The DOM
 * half (click interception, popstate) has no DOM to run against here; it is
 * verified in a live browser against the scratch app, and the helpers below
 * are the logic it dispatches on.
 */
describe('defineLayout', () => {
  afterAll(() => {
    ;(globalThis as any).__vue_route = undefined
  })

  test('refuses a page that is not a catch-all', () => {
    ;(globalThis as any).__vue_route = {
      catchAll: false,
      base: '/reports',
      param: null,
    }
    expect(() => defineLayout()).toThrow(/only available on catch-all pages/)

    ;(globalThis as any).__vue_route = undefined
    expect(() => defineLayout()).toThrow(/only available on catch-all pages/)
  })

  test('a catch-all page gets segments and listeners', () => {
    ;(globalThis as any).__vue_route = {
      catchAll: true,
      base: '/wiki',
      param: 'page',
    }
    const layout = defineLayout()
    expect(layout.base).toBe('/wiki')
    expect(Array.isArray(layout.segments.value)).toBe(true)

    const seen: string[][] = []
    const off = layout.on(next => {
      seen.push(next)
    })
    layout.navigate(['setup', 'mysql'])
    expect(seen).toEqual([['setup', 'mysql']])
    expect(layout.segments.value).toEqual(['setup', 'mysql'])

    // A cancelling listener stops the navigation.
    layout.on(() => false)
    layout.navigate(['blocked'])
    expect(layout.segments.value).toEqual(['setup', 'mysql'])

    off()
  })

  test('isUnderBase is prefix-safe, segmentsUnder is exact', () => {
    expect(isUnderBase('/admin', '/admin')).toBe(true)
    expect(isUnderBase('/admin', '/admin/users/7')).toBe(true)
    expect(isUnderBase('/admin', '/administrator')).toBe(false)
    expect(isUnderBase('', '/anything')).toBe(true)

    expect(segmentsUnder('/admin', '/admin')).toEqual([])
    expect(segmentsUnder('/admin', '/admin/users/7')).toEqual(['users', '7'])
    expect(segmentsUnder('', '/a/b')).toEqual(['a', 'b'])
  })
})

describe('handleHtml stamps and links', () => {
  test('the shell carries __vue_route when the route is known', async () => {
    const parsed = await parse('site/reports.vue')
    const res = await VueHandler.handleHtml(
      'st-1',
      {},
      '/site/reports.vue',
      undefined,
      parsed,
      { catchAll: true, base: '/site', param: 'slug' },
    )
    const html = await (res as Response).text()
    expect(html).toContain('"catchAll":true')
    expect(html).toContain('"base":"/site"')
    expect(html).toContain('"param":"slug"')
  })

  test('no route argument, no stamp — old callers stay byte-identical', async () => {
    const parsed = await parse('site/reports.vue')
    const res = await VueHandler.handleHtml(
      'st-2',
      {},
      '/site/reports.vue',
      undefined,
      parsed,
    )
    const html = await (res as Response).text()
    expect(html).not.toContain('__vue_route')
  })

  test("the layout's stylesheet links before the page root script", async () => {
    const parsed = await parse('site/reports.vue')
    expect(parsed.layoutRoute).toBe('/site/layout.vue')

    const res = await VueHandler.handleHtml(
      'st-3',
      {},
      '/site/reports.vue',
      undefined,
      parsed,
    )
    const html = await (res as Response).text()
    const linkAt = html.indexOf('/site/layout.vue?__vue_css=true')
    const rootAt = html.indexOf('__vue_script=root')
    expect(linkAt).toBeGreaterThan(-1)
    expect(rootAt).toBeGreaterThan(linkAt)
  })
})

describe('navigate() path forms', () => {
  test('segments, relative and absolute all normalise under the base', () => {
    ;(globalThis as any).__vue_route = {
      catchAll: true,
      base: '/wiki',
      param: 'page',
    }
    const layout = defineLayout()

    layout.navigate('setup/pg')
    expect(layout.segments.value).toEqual(['setup', 'pg'])

    layout.navigate('/wiki/absolute/path')
    expect(layout.segments.value).toEqual(['absolute', 'path'])

    layout.navigate([])
    expect(layout.segments.value).toEqual([])

    // Outside the base: a real navigation in a browser; here there is no
    // `location`, so the only observable contract is that segments do not
    // pretend the subtree contains it.
    layout.navigate('/somewhere/else')
    expect(layout.segments.value).toEqual([])
    ;(globalThis as any).__vue_route = undefined
  })
})

/**
 * The maintainer's counterexample: a catch-all with a more specific sibling.
 *
 *   admin/[...slug].vue
 *   admin/faculty/[id].vue
 *
 * `/admin/faculty/7` is under the base but belongs to `[id].vue` on the
 * server, so the client-side router must yield it to a real navigation — a
 * soft-nav would render the catch-all where a hard reload renders a
 * different page. The stamp carries what the siblings claim; the client
 * refuses to soft-nav into it.
 */
describe('defineLayout yields to more specific routes', () => {
  test('the stamp names sibling claims, at first-segment granularity', async () => {
    await write('estate/[...slug].vue', PAGE)
    await write('estate/faculty/[id].vue', PAGE)
    await write('estate/reports.vue', PAGE)
    await write('estate/layout.vue', LAYOUT)

    // Reach the stamp through the same helper the handler uses.
    const { claimedBeside } = await import('./handler')
    const stamp = claimedBeside(`${ROOT}/estate/[...slug].vue`)

    expect(stamp.claimed).toContain('faculty')
    expect(stamp.claimed).toContain('reports')
    expect(stamp.claimed).toContain('reports.vue')
    // The layout claims nothing, and the catch-all is the page itself.
    expect(stamp.claimed).not.toContain('layout')
    expect(stamp.claimed).not.toContain('layout.vue')
    expect(stamp.claimedSingle).toBe(false)
  })

  test('a [param] sibling claims every single-segment path', async () => {
    await write('branch/[...slug].vue', PAGE)
    await write('branch/[warehouse].vue', PAGE)

    const { claimedBeside } = await import('./handler')
    const stamp = claimedBeside(`${ROOT}/branch/[...slug].vue`)
    expect(stamp.claimedSingle).toBe(true)
  })

  test('the client refuses to soft-nav into claimed territory', () => {
    ;(globalThis as any).__vue_route = {
      catchAll: true,
      base: '/admin',
      param: 'slug',
      claimed: ['faculty', 'reports'],
      claimedSingle: false,
    }
    const layout = defineLayout()

    layout.navigate(['dashboard', 'stats'])
    expect(layout.segments.value).toEqual(['dashboard', 'stats'])

    // Claimed by faculty/[id].vue: without `location` (no DOM here) the
    // observable contract is that no soft state change happens.
    layout.navigate(['faculty', '7'])
    expect(layout.segments.value).toEqual(['dashboard', 'stats'])

    layout.navigate(['reports'])
    expect(layout.segments.value).toEqual(['dashboard', 'stats'])
    ;(globalThis as any).__vue_route = undefined
  })

  test('claimedSingle blocks one segment, not deeper paths', () => {
    ;(globalThis as any).__vue_route = {
      catchAll: true,
      base: '/branch',
      param: 'slug',
      claimed: [],
      claimedSingle: true,
    }
    const layout = defineLayout()

    layout.navigate(['solo'])
    expect(layout.segments.value).toEqual([])

    layout.navigate(['deep', 'path'])
    expect(layout.segments.value).toEqual(['deep', 'path'])
    ;(globalThis as any).__vue_route = undefined
  })
})

/**
 * The stamp is serialized into the HTML of every served page, so each name in
 * it is published to any visitor. A smoke test of the published alpha read
 * `sample.bin`, `script.ts` and `index.tsx` out of a page's
 * `__vue_route.claimed` — every sibling stem, route or not, was enumerated
 * into the response: a directory listing of `src/`, in production. The stamp
 * carries route claims only, measured against the handler's own extension
 * table; a directory claims only when a route file exists somewhere under it.
 */
describe('the stamp names routes, not the directory', () => {
  beforeAll(async () => {
    await write('depot/[...slug].vue', PAGE)
    await write('depot/prices.vue', PAGE)
    await write('depot/sample.bin', 'not a route')
    await write('depot/script.ts', 'export default {}')
    await write('depot/index.tsx', 'export default () => null')
    await write('depot/[note].txt', 'a dynamic-shaped name, not a route')
    await write('depot/assets/logo.svg', '<svg xmlns="http://www.w3.org/2000/svg" />')
    await write('depot/parts/deep/panel.vue', PAGE)
  })

  test('non-route siblings never reach the claims', async () => {
    const { claimedBeside } = await import('./handler')
    const stamp = claimedBeside(`${ROOT}/depot/[...slug].vue`)

    // Routes claim: the sibling page in both spellings, and the directory
    // holding a page below it — however deep.
    expect(stamp.claimed).toContain('prices')
    expect(stamp.claimed).toContain('prices.vue')
    expect(stamp.claimed).toContain('parts')

    // Non-routes do not, under either spelling.
    expect(stamp.claimed).not.toContain('sample.bin')
    expect(stamp.claimed).not.toContain('sample')
    expect(stamp.claimed).not.toContain('script.ts')
    expect(stamp.claimed).not.toContain('script')
    expect(stamp.claimed).not.toContain('index.tsx')
    expect(stamp.claimed).not.toContain('index')
    // A directory of assets holds no route, so its name is nobody's business.
    expect(stamp.claimed).not.toContain('assets')
    // A dynamic-shaped name only counts with a routed extension.
    expect(stamp.claimedSingle).toBe(false)
  })

  test('the served HTML carries route claims and nothing else', async () => {
    const parsed = await parse('depot/[...slug].vue')
    const { claimedBeside } = await import('./handler')
    const res = await VueHandler.handleHtml(
      'st-4',
      {},
      '/depot/[...slug].vue',
      undefined,
      parsed,
      {
        catchAll: true,
        base: '/depot',
        param: 'slug',
        ...claimedBeside(`${ROOT}/depot/[...slug].vue`),
      },
    )
    const html = await (res as Response).text()

    expect(html).toContain('"claimed"')
    expect(html).toContain('prices')
    expect(html).not.toContain('sample.bin')
    expect(html).not.toContain('script.ts')
    expect(html).not.toContain('index.tsx')
  })
})
