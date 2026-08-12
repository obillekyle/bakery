import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { hostKey } from '@bakery-framework/core/core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { fs, toHash } from '@bakery-framework/core/utils'
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
