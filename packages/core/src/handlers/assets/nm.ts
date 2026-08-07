import { bundleModule } from '../../compiler'
import { Bakery } from '../../core/bakery'
import { toHash } from '../../utils/common'
import { fs } from '../../utils/fs'
import { Handler } from '../core/$base'

export class NMHandler extends Handler {
  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'nm_cache')
  }

  static canHandle(path: string) {
    return path.startsWith('/_nm/')
  }

  /**
   * Serve a browser-ready bundle of a file inside `node_modules`.
   *
   * **Why this does not call `getStatic`.** `getStatic` is the single writer of
   * the containment + `.forbidden` pair, and three of the four handlers its doc
   * comment names now go through it. This one cannot, and the reason is not
   * the root (it takes a `roots` argument) — it is that `getStatic` answers
   * "is there a plain file literally at this path", and `/_nm/` deliberately
   * asks a different question. The entry here goes to `Bun.build`, which does
   * Node resolution: `/_nm/pkg/sub` resolves to `pkg/sub/index.js`, and that is
   * precisely what the import map's `"<pkg>/": "/_nm/<pkg>/"` prefix entry
   * (`utils/http/dom.ts`) produces for an extensionless subpath import.
   * `getStatic` returns `null` for that path — it is a directory — so routing
   * through it would turn every extensionless subpath import into a 204.
   * `nm.test.ts` pins both halves of that divergence.
   *
   * What *was* missing is the second half of the pair. Containment was spelled
   * out here and was correct, but `.forbidden` was never checked, so `/_nm/*`
   * was the one file-serving surface an operator could not pull offline with a
   * marker file. Both checks are below, in `getStatic`'s order and with its
   * semantics, against the `node_modules` root.
   *
   * The `.forbidden` walk has to happen *before* the cache lookup, not after:
   * `getOrCreateCachedFile` answers from `.cache/nm_cache` without touching the
   * source tree, so a marker dropped on an already-served package would
   * otherwise be invisible until the cache was cleared.
   */
  static async handle(path: string) {
    const nmPath = path.replace(/^\/_nm\//, 'node_modules/')
    const nmRoot = fs.resolve(Bakery.root, 'node_modules')
    const nodeModulesPath = fs.resolve(Bakery.root, nmPath)

    // Strictly below the root, so `node_modules` itself is not an entry point.
    // `getStatic` admits `file === root` and then rejects it as a directory;
    // here the same answer has to come from the containment test, because
    // nothing downstream stats the path.
    if (!nodeModulesPath.startsWith(`${nmRoot}/`)) return undefined
    if (fs.isForbidden(nodeModulesPath, nmRoot)) return undefined

    const nmFile = Bun.file(nodeModulesPath)
    const sourceMtime = fs.exists(nmFile) ? nmFile.lastModified : null

    const cacheId = toHash(nmPath)
    const cacheName = `${cacheId}.js`

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      sourceMtime,
      async () => {
        const module = await bundleModule(nodeModulesPath)
        return module.success && module.content ? module.content : null
      },
    )

    return cached || undefined
  }
}
