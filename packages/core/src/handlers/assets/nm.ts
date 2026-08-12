import { bundleModule } from '../../compiler'
import { Bakery } from '../../core/bakery'
import { Try, toHash } from '../../utils/common'
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
   * The file a `/_nm/` path names.
   *
   * **The literal path wins whenever it exists, and the order is the whole
   * point.** `Bun.build` resolves a directory or package entry itself, with
   * *browser* conditions — which is what picks `vue`'s `esm-bundler` build over
   * the CJS one behind its `node` condition. `Bun.resolveSync` has no such
   * knob: it answers with Bun's own server conditions. Resolving here first and
   * handing `Bun.build` the concrete file therefore silently downgraded every
   * package with a `browser`/`node` split — `/_nm/vue` came back as
   * `index.mjs` re-exporting `vue.cjs.js`, and the browser then rejected
   * `import { Fragment } from 'vue'`.
   *
   * So the literal path goes first whenever it is on disk, and `resolveSync` is
   * the second candidate rather than the first. It is still needed, for two
   * distinct cases: a public subpath that does not match the physical layout —
   * `@vue-material/core` maps `"./utils"` to `./dist/utils/index.js`, so the
   * documented `@vue-material/core/utils` has no `utils` directory to find and
   * used to 500 — and a package whose root is declared *only* through
   * `exports`, where `Bun.build` on the directory answers `ModuleNotFound`
   * because it looks for `main`/`module` and finds neither.
   *
   * Hence a list rather than one answer: the caller bundles the first candidate
   * that builds. Both orders are wrong on their own.
   */
  private static resolveEntry(nmPath: string, nmRoot: string): string[] {
    const literal = fs.resolve(Bakery.root, nmPath)
    const candidates = fs.exists(literal) ? [literal] : []

    const specifier = nmPath.replace(/^node_modules\//, '')

    try {
      const resolved = fs.resolve(Bun.resolveSync(specifier, Bakery.root))
      // A resolver answer still has to be inside `node_modules`: an `exports`
      // map and a `browser` field can both point outside the package, and this
      // path is reachable from a URL.
      if (resolved.startsWith(`${nmRoot}/`) && resolved !== literal) {
        candidates.push(resolved)
      }
    } catch {
      // Not exposed by the map, or no map to consult.
    }

    return candidates.length ? candidates : [literal]
  }

  /**
   * Serve a browser-ready bundle of a file inside `node_modules`.
   *
   * **Why this does not call `getStatic`.** `getStatic` is the single writer of
   * the containment + `.forbidden` pair, and three of the four handlers its doc
   * comment names now go through it. This one cannot, and the reason is not
   * the root (it takes a `roots` argument) — it is that `getStatic` answers
   * "is there a plain file literally at this path", and `/_nm/` deliberately
   * asks a different question: what would an importer of this specifier get?
   * `resolveEntry` answers it, applying the package's `exports` map, and
   * `Bun.build` then does directory-index resolution on whatever survives — so
   * `/_nm/pkg/sub` reaches `pkg/sub/index.js`, which is precisely what the
   * import map's `"<pkg>/": "/_nm/<pkg>/"` prefix entry (`utils/http/dom.ts`)
   * produces for an extensionless subpath import. `getStatic` returns `null`
   * for that path — it is a directory — so routing through it would turn every
   * extensionless subpath import into a 204. `nm.test.ts` pins both halves of
   * that divergence.
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
    const candidates = this.resolveEntry(nmPath, nmRoot)

    // Strictly below the root, so `node_modules` itself is not an entry point.
    // `getStatic` admits `file === root` and then rejects it as a directory;
    // here the same answer has to come from the containment test, because
    // nothing downstream stats the path. Every candidate is checked: the
    // resolver's answer is no more trusted than the URL's.
    const allowed = candidates.filter(
      candidate =>
        candidate.startsWith(`${nmRoot}/`) &&
        !fs.isForbidden(candidate, nmRoot),
    )
    if (!allowed.length) return undefined

    const nmFile = Bun.file(allowed[0])
    const sourceMtime = fs.exists(nmFile) ? nmFile.lastModified : null

    const cacheId = toHash(nmPath)
    const cacheName = `${cacheId}.js`

    const cached = await fs.getOrCreateCachedFile(
      this.cacheDir,
      cacheName,
      sourceMtime,
      async () => {
        for (const candidate of allowed) {
          // Wrapped: an entry point Bun cannot resolve is a *throw*, not a
          // `success: false`, and that is the expected outcome of the first
          // candidate for a package whose root exists only in `exports`.
          const [err, module] = await Try.catch(() => bundleModule(candidate))
          if (!err && module?.success && module.content) return module.content
        }
        return null
      },
    )

    return cached || undefined
  }
}
