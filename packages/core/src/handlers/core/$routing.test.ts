import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { fs } from '../../utils'
import { dynamicGlobs, getRoute } from './$routing'

const ROOT = fs.resolve(process.cwd(), '.cache/__routing-test__')

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
  // The `!` form: claims its bare directory, unless an index exists.
  await write('admin/[...slug!].tsx')
  await write('shop/[...slug!].tsx')
  await write('shop/index.tsx')
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

const find = (path: string, options = {}) =>
  getRoute(path, ['tsx'], ROOT, ROOT, options)

/**
 * Route discovery must never hand back a file outside the root it was given,
 * whatever the glob layer does.
 *
 * This is a regression test for a Windows-only escape that was live in every
 * release before it was found, and it is written to fail on Linux too if the
 * containment clamp is removed — the glob is only how the escape was *reached*.
 *
 * `dynamicGlobs` spelled a literal asterisk as `\*`. On Windows `\` is a path
 * separator, so Bun read the pattern as drive-absolute, ignored the `cwd` in
 * `GETFILE`, and matched files at `C:\`. `getRoute` resolved one and asked
 * `fs.isForbidden`, whose walk is bounded by `startsWith(root)` — so an
 * out-of-root path skipped the loop and came back "allowed". The result was a
 * `Route.Info` whose `path` was `../../../../../../$WINRE_BACKUP_PARTITION.MARKER`.
 *
 * `ext` is `[]` here on purpose. That is what `DynamicHandler.config` uses, and
 * it is what makes the pattern `.*` rather than `.{tsx}` — with an extension
 * filter the escape needed a matching file at the drive root to be observable,
 * which is why narrower handlers hid it.
 */
describe('getRoute — a resolved file is always inside the root', () => {
  test('an extension-less dynamic scan cannot escape the root', async () => {
    const deep = fs.resolve(ROOT, 'a/b/c')
    for (const path of ['/x', '/x/y', '/x/y/z']) {
      for (const options of [{}, { dynamicOnly: true }, { staticOnly: true }]) {
        for (const dir of [ROOT, deep]) {
          const info = await getRoute(path, [], dir, ROOT, options)
          if (!info) continue
          expect(`${path}:${info.filePath}`).toBe(
            `${path}:${info.filePath!.startsWith(`${ROOT}/`) ? info.filePath : 'ESCAPED'}`,
          )
        }
      }
    }
  })

  test('the single-param globs stay inside the cwd they are scanned with', async () => {
    // The glob half, pinned directly. `getRoute` cannot pin it: the
    // `fs.isForbidden` clamp rejects an escaped file downstream, so the buggy
    // and fixed spellings produce identical results through the public path.
    //
    // Scanned against a directory containing exactly one file. Any hit that is
    // not that file came from somewhere the `cwd` option was supposed to
    // exclude — on Windows, `\*.*` returned four files from `C:\`.
    const box = fs.resolve(ROOT, 'globbox')
    await Bun.write(`${box}/only.tsx`, '\n')

    const found: string[] = []
    for (const glob of dynamicGlobs('')) {
      for await (const hit of glob.scan({
        absolute: true,
        cwd: box,
        dot: true,
        onlyFiles: true,
      })) {
        found.push(fs.resolve(hit))
      }
    }

    const escaped = found.filter(f => !f.startsWith(`${box}/`))
    expect(escaped).toEqual([])
  })

  test('a literal-asterisk route file is still matched where one can exist', async () => {
    // `*` is a reserved character in a Windows filename, so the route form the
    // pattern exists for is POSIX-only. Skipping rather than deleting the case
    // keeps the coverage on the platform that can hold it — and CI is Linux.
    if (process.platform === 'win32') return
    const star = `${ROOT}/star/${String.fromCharCode(42)}.tsx`
    await Bun.write(star, 'export default () => null\n')
    const info = await getRoute('/star/anything', ['tsx'], ROOT, ROOT)
    expect(info?.filePath).toBe(star as fs.AbsolutePath)
  })
})

describe('getRoute — catch-all discovery', () => {
  test('a multi-segment request reaches the catch-all through directories that do not exist', async () => {
    const info = await find('/w/a/b/c')
    expect(info).not.toBeNull()
    expect(info!.path).toBe('w/[...page].tsx')
    expect(info!.catchAll).toBe(true)
    expect(info!.getParams('/w/a/b/c')).toEqual({ page: ['a', 'b', 'c'] })
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

  test('[...slug!] claims its bare directory and binds []', async () => {
    const info = await find('/admin')
    expect(info).not.toBeNull()
    expect(info!.path).toBe('admin/[...slug!].tsx')
    expect(info!.optionalCatchAll).toBe(true)
    expect(info!.getParams('/admin')).toEqual({ slug: [] })
  })

  test('[...slug!] still answers deeper paths, as segments', async () => {
    const info = await find('/admin/users/7')
    expect(info!.path).toBe('admin/[...slug!].tsx')
    expect(info!.getParams('/admin/users/7')).toEqual({ slug: ['users', '7'] })
  })

  test('an index sibling still wins the bare directory over [...slug!]', async () => {
    const info = await find('/shop')
    expect(info!.path).toBe('shop/index.tsx')
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
    expect(info!.getParams('/q3/sub')).toEqual({ rest: ['sub'] })
  })

  test('paths with no on-disk counterpart still serve', async () => {
    const info = await find('/q3/anything/else')
    expect(info!.getParams('/q3/anything/else')).toEqual({
      rest: ['anything', 'else'],
    })
  })
})

describe('getRoute — the yield check never probes outside the root', () => {
  const OUTSIDE = fs.resolve(ROOT, '../__outside-probe__.txt')

  afterAll(async () => {
    await rm(OUTSIDE, { force: true })
  })

  test('a rest that escapes the directory is not turned into an existence oracle', async () => {
    // URL parsing normalises `..` away, so this is unreachable over HTTP —
    // but any caller that skips that normalisation must not be able to use
    // the catch-all's yield stat to probe arbitrary filesystem paths. The
    // answer must be identical whether or not the outside file exists.
    const probe = '/q3/../../__outside-probe__.txt'

    await rm(OUTSIDE, { force: true })
    const missing = await find(probe)

    await Bun.write(OUTSIDE, 'secret\n')
    const present = await find(probe)

    expect(present?.path ?? null).toBe(missing?.path ?? null)
  })
})
