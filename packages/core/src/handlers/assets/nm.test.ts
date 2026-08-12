import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bakery } from '../../core/bakery'
import { initConfig } from '../../core/config'
import { getStatic } from '../core/$static'
import { NMHandler } from './nm'

/**
 * `/_nm/*` serves files out of `node_modules`, and it was the one file-serving
 * surface that never moved onto `getStatic` — it hand-rolled a `startsWith`
 * containment test and stopped there. The containment was correct; the
 * `.forbidden` marker every other surface honours (`StaticHandler`,
 * `PublicHandler`, `ImageHandler`, `getRoute`, and `router.ts` itself) was
 * simply not checked, so an operator pulling a package offline with a marker
 * file found `/_nm/` still serving it.
 *
 * The root here is `node_modules`, not the serve root, so this needs its own
 * fixture tree rather than riding on the app's.
 */
describe('NMHandler — containment and .forbidden', () => {
  let dir: string
  const realRoot = Bakery.root
  const realCache = Bakery.cacheDir

  const nm = (rel: string) => join(dir, 'node_modules', rel)

  beforeAll(async () => {
    await initConfig()
    dir = await mkdtemp(join(tmpdir(), 'bakery-nm-'))

    await Bun.write(nm('ok-pkg/index.js'), 'export const ok = 1\n')
    await Bun.write(nm('ok-pkg/sub/index.js'), 'export const sub = 2\n')
    await Bun.write(nm('secret-pkg/index.js'), 'export const secret = 3\n')
    await Bun.write(nm('secret-pkg/.forbidden'), '')
    // The marker also has to hide a *subtree*, not just its own directory —
    // `isForbidden` walks every level between the target and the root.
    await Bun.write(nm('hidden-pkg/dist/deep/index.js'), 'export const d = 4\n')
    await Bun.write(nm('hidden-pkg/.forbidden'), '')
    // Reachable only by escaping node_modules.
    await Bun.write(join(dir, 'outside.js'), 'export const outside = 5\n')

    // A package whose public subpath does not match its physical layout, which
    // is the only way to tell "resolved through the exports map" apart from
    // "found a directory of that name".
    await Bun.write(
      nm('mapped-pkg/package.json'),
      JSON.stringify({
        name: 'mapped-pkg',
        version: '1.0.0',
        exports: { '.': './dist/main.js', './utils': './dist/utils/index.js' },
      }),
    )
    await Bun.write(nm('mapped-pkg/dist/main.js'), 'export const main = 6\n')
    await Bun.write(
      nm('mapped-pkg/dist/utils/index.js'),
      'export const mapped = 7\n',
    )

    // Plain data properties on the service locator (`readonly` in the ambient
    // type only), so this is a swap-and-restore rather than a module mock —
    // convention 9.
    ;(Bakery as any).root = dir
    ;(Bakery as any).cacheDir = join(dir, '.cache')
  })

  afterAll(async () => {
    ;(Bakery as any).root = realRoot
    ;(Bakery as any).cacheDir = realCache
    await rm(dir, { recursive: true, force: true })
  })

  test('canHandle claims only the /_nm/ namespace', () => {
    expect(NMHandler.canHandle('/_nm/ok-pkg/index.js')).toBe(true)
    expect(NMHandler.canHandle('/_nmx/ok-pkg/index.js')).toBe(false)
    expect(NMHandler.canHandle('/ok-pkg/index.js')).toBe(false)
  })

  test('an ordinary package file still serves', async () => {
    const res = await NMHandler.handle('/_nm/ok-pkg/index.js')
    expect(res).toBeTruthy()
    expect(await (res as Bun.BunFile).text()).toContain('ok')
  })

  /**
   * The reason `NMHandler` cannot simply call `getStatic` — see the comment in
   * `nm.ts`. `Bun.build` does Node resolution on the entry, so an extensionless
   * subpath resolves to its `index.js`; that is exactly what the import map's
   * `"<pkg>/": "/_nm/<pkg>/"` prefix entry produces for `import 'pkg/sub'`.
   * `getStatic` answers "is there a plain file literally at this path", and
   * would refuse it.
   */
  test('an extensionless subpath still resolves to its index', async () => {
    const res = await NMHandler.handle('/_nm/ok-pkg/sub')
    expect(res).toBeTruthy()
    expect(await (res as Bun.BunFile).text()).toContain('sub')
    // Pinning the divergence itself, so this stops being a claim in a comment.
    expect(await getStatic('/ok-pkg/sub', join(dir, 'node_modules'))).toBeNull()
  })

  /**
   * The subpath a package *documents* has to work, and only the `exports` map
   * says what that is. `mapped-pkg/utils` lives at `dist/utils/index.js`, so
   * treating `/_nm/mapped-pkg/utils` as a filesystem path looks for a `utils`
   * directory that does not exist and 500s — which is what
   * `@vue-material/core/utils` did.
   */
  test('a subpath resolves through the package exports map', async () => {
    const res = await NMHandler.handle('/_nm/mapped-pkg/utils')
    expect(res).toBeTruthy()
    expect(await (res as Bun.BunFile).text()).toContain('mapped')

    // There is genuinely no such directory — so this passing means the map was
    // consulted, not that the path happened to exist.
    expect(await Bun.file(nm('mapped-pkg/utils')).exists()).toBe(false)
  })

  test('the package root resolves through the exports map too', async () => {
    const res = await NMHandler.handle('/_nm/mapped-pkg')
    expect(res).toBeTruthy()
    expect(await (res as Bun.BunFile).text()).toContain('main')
  })

  /**
   * The fallback. A package with no `exports` map is importable by physical
   * path, and `Bun.resolveSync` throws rather than answering for those — so
   * losing the literal path would break every pre-`exports` package.
   */
  test('a package without an exports map still serves by physical path', async () => {
    const res = await NMHandler.handle('/_nm/ok-pkg/sub/index.js')
    expect(res).toBeTruthy()
    expect(await (res as Bun.BunFile).text()).toContain('sub')
  })

  test('a .forbidden marker beside the file refuses it', async () => {
    expect(await NMHandler.handle('/_nm/secret-pkg/index.js')).toBeUndefined()
  })

  test('a .forbidden marker above the file hides the whole subtree', async () => {
    expect(
      await NMHandler.handle('/_nm/hidden-pkg/dist/deep/index.js'),
    ).toBeUndefined()
  })

  test('the marker hides an extensionless entry point too', async () => {
    expect(await NMHandler.handle('/_nm/hidden-pkg')).toBeUndefined()
    expect(await NMHandler.handle('/_nm/hidden-pkg/dist/deep')).toBeUndefined()
  })

  test('traversal out of node_modules is refused', async () => {
    // Belt-and-braces: `outside.js` really is there, so these are containment
    // refusals and not a missing file.
    expect(await Bun.file(join(dir, 'outside.js')).exists()).toBe(true)
    expect(await NMHandler.handle('/_nm/../outside.js')).toBeUndefined()
    expect(
      await NMHandler.handle('/_nm/ok-pkg/../../outside.js'),
    ).toBeUndefined()
  })
})
