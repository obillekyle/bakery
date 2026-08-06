import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { fs } from '../../utils'
import { getRoute } from './$routing'

const ROOT = fs.resolve(process.cwd(), '.bakery/cache/__routing-test__')

const write = (rel: string) =>
  Bun.write(`${ROOT}/${rel}`, 'export default () => null\n')

beforeAll(async () => {
  // The whole precedence ladder in one tree:
  //   w/[...page].tsx            root catch-all for /w/**
  //   docs/[id].tsx              single-param sibling
  //   docs/[...slug].tsx         same-level catch-all
  //   docs/a/index.tsx           child index under the catch-all's prefix
  //   docs/guides/[...rest].tsx  deeper catch-all
  await write('w/[...page].tsx')
  await write('docs/[id].tsx')
  await write('docs/[...slug].tsx')
  await write('docs/a/index.tsx')
  await write('docs/guides/[...rest].tsx')
  // No single-param sibling here: isolates child-index vs catch-all.
  await write('pages/[...slug].tsx')
  await write('pages/a/index.tsx')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const find = (path: string, options = {}) =>
  getRoute(path, ['tsx'], ROOT, ROOT, options)

describe('getRoute — catch-all discovery', () => {
  test('a multi-segment request reaches the catch-all through directories that do not exist', async () => {
    const info = await find('/w/a/b/c')
    expect(info).not.toBeNull()
    expect(info!.path).toBe('w/[...page].tsx')
    expect(info!.catchAll).toBe(true)
    expect(info!.getParams('/w/a/b/c')).toEqual({ page: 'a/b/c' })
  })

  test('staticOnly never returns a catch-all', async () => {
    expect(await find('/w/a/b/c', { staticOnly: true })).toBeNull()
  })

  test('the deepest existing directory claims the rest first', async () => {
    const info = await find('/docs/guides/routing/anchors')
    expect(info!.path).toBe('docs/guides/[...rest].tsx')
  })

  test('a single-param sibling wins over the same-level catch-all', async () => {
    const info = await find('/docs/42')
    expect(info!.path).toBe('docs/[id].tsx')
  })

  test('a same-level single-param wins over a child index (pre-existing semantics)', async () => {
    // Not new behavior — pinned so the catch-all work can't drift it.
    const info = await find('/docs/a')
    expect(info!.path).toBe('docs/[id].tsx')
  })

  test('a child index wins over the parent catch-all', async () => {
    const info = await find('/pages/a')
    expect(info!.path).toBe('pages/a/index.tsx')
  })

  test('a bare directory request is not claimed by its own catch-all', async () => {
    // /w has no index; the catch-all requires at least one rest segment.
    expect(await find('/w')).toBeNull()
  })
})

describe('getRoute — catch-alls yield to real files', () => {
  beforeAll(async () => {
    await Bun.write(`${ROOT}/q3/[...rest].tsx`, 'export default () => null\n')
    await Bun.write(`${ROOT}/q3/style.css`, 'body{}\n')
    await Bun.write(`${ROOT}/q3/img/logo.png`, 'png\n')
    await Bun.write(`${ROOT}/q3/sub/thing.txt`, 'txt\n')
  })

  test('a same-level literal file is never claimed, whatever its extension', async () => {
    expect(await find('/q3/style.css')).toBeNull()
  })

  test('a deeper literal file is never claimed either', async () => {
    expect(await find('/q3/img/logo.png')).toBeNull()
  })

  test('a directory path (not a file) still falls to the catch-all', async () => {
    const info = await find('/q3/sub')
    expect(info!.path).toBe('q3/[...rest].tsx')
    expect(info!.getParams('/q3/sub')).toEqual({ rest: 'sub' })
  })

  test('paths with no on-disk counterpart still serve', async () => {
    const info = await find('/q3/anything/else')
    expect(info!.getParams('/q3/anything/else')).toEqual({
      rest: 'anything/else',
    })
  })
})
