import {
  readFileSync as fsRfs,
  existsSync as nodeExistsSync,
  statSync as nodeStatSync,
} from 'node:fs'
import { mkdir as fsMkdir, rm as fsRm } from 'node:fs/promises'
import {
  dirname as nodeDirname,
  relative as nodeRelative,
  resolve,
} from 'node:path'
import { parse as parsedPath } from 'node:path/posix'
import { promisify } from 'node:util'
import { gzip as zlibGzip } from 'node:zlib'
import { LRUCache } from '../cache/lru'
// A cycle on paper (`core/context` imports this file for `getAppVersion`),
// harmless in practice: neither module touches the other's bindings during
// evaluation — `hostStore` is only read inside `isForbidden`, at request time.
import { hostStore } from '../core/context'
import type { MixedPromise } from '../types'
import { is, Try } from './common'

type CompressInput = string | Uint8Array | ArrayBuffer

const gzipAsync = promisify(zlibGzip) as (
  data: CompressInput,
) => Promise<Uint8Array>

/**
 * Payloads at or above this size compress off the request thread via
 * `compressAsync`; below it, sync stays. The thread-pool round-trip has a
 * fixed dispatch cost (~85us zstd, ~450us gzip on this machine) that a small
 * payload's stall never earns back. Median per-call cost, Bun 1.3.14,
 * measured 2026-08-06 (interleaved same-run A/B):
 *
 *   size  | zstd sync | zstd async | gzip sync | gzip async
 *   2KB   |    10.5us |     94.4us |    23.8us |    285.9us
 *   16KB  |    41.7us |    140.5us |   126.2us |    434.1us
 *   32KB  |    98.2us |    189.2us |   ~300us  |    ~750us
 *   64KB  |   163.9us |    276.6us |   623.1us |    989.9us
 *   135KB |  1022.5us |   1204.9us |  1382.2us |   1761.7us
 *   1MB   |   5804us  |    6480us  |  14469us  |  17114us
 *   (32KB gzip: median of 5 x 200-iteration runs; single runs were noisy)
 *
 * At 32KB the sync cost crosses the dispatch overhead for zstd — the
 * first-preference codec. gzip's raw-latency break-even sits nearer 64KB,
 * but the sync figure is a *stall* shared by every concurrent request while
 * the async figure is latency private to one caller, so the tie goes to
 * offloading rather than a second per-codec constant.
 */
export const ASYNC_COMPRESSION_MIN = 32 * 1024

/**
 * `compress` is the sync variant (blocks the event loop for the durations
 * above); `compressAsync` runs on a worker pool and only parks the caller.
 * zstd: `Bun.zstdCompress` (native async, Bun >= 1.1.21). gzip: Bun 1.3.14
 * has no async `Bun.gzip`, so `node:zlib`'s callback `gzip` — which runs on
 * the libuv pool — is promisified instead. Both async variants were verified
 * byte-identical to their sync counterparts on this Bun, so either path
 * yields the same cached artifacts and the same response bodies.
 */
export const COMPRESSION_MAP = [
  {
    encoding: 'zstd',
    ext: '.zst',
    compress: Bun.zstdCompressSync,
    compressAsync: (data: CompressInput) => Bun.zstdCompress(data),
  },
  {
    encoding: 'gzip',
    ext: '.gz',
    compress: Bun.gzipSync,
    compressAsync: gzipAsync,
  },
]

type MixedArray<T> = T | T[]

function toArray<T>(val?: MixedArray<T>): T[] {
  if (val === undefined) return []
  return Array.isArray(val) ? val : [val]
}

/**
 * Memoised: `resolve` measures ~16-20us on Bun/Windows (see `isForbidden`) and
 * a CPU profile of the request path put `safeResolve` + `path.resolve` at over
 * 40% of per-request self time. Caching is safe because the function is purely
 * lexical — `path.resolve` reads no filesystem state, only `process.cwd()`.
 * Relative arguments make entries cwd-dependent, and while nothing in the
 * runtime calls `chdir`, tests do (config.broken.test.ts boots from temp
 * fixture dirs) — so the cache is invalidated wholesale when cwd moves. The
 * check is one `process.cwd()` read per call, measured at 12ns in Bun (it is
 * cached natively), against the ~16us a resolve costs. The cache is an LRU,
 * not a Map, because arguments derive from request paths (convention 6);
 * constant keys like the cache-dir getters stay hot forever.
 */
const resolveCache = new LRUCache<string, FileSystem.AbsolutePath>(4096)
let resolveCacheCwd = process.cwd()

function safeResolve(...paths: string[]): FileSystem.AbsolutePath {
  const cwd = process.cwd()
  if (cwd !== resolveCacheCwd) {
    resolveCache.clear()
    resolveCacheCwd = cwd
  }
  // NUL is invalid in a path on every platform, so joined keys cannot collide
  // across different argument splits ('a b'+'c' vs 'a'+'b c').
  const key = paths.length === 1 ? paths[0] : paths.join('\u0000')
  const cached = resolveCache.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve(...paths).replace(
    /\\/g,
    '/',
  ) as FileSystem.AbsolutePath
  resolveCache.set(key, resolved)
  return resolved
}
// prettier-ignore
const compressable = new Set([
  'html',
  'htm',
  'xml',
  'css',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'ttf',
  'otf',
  'txt',
  'text',
  'svg',
  'md',
  'wasm',
  'map',
  'csv',
  'yml',
  'yaml',
  'mdx',
])

export namespace Glob {
  export type Pattern = string | Bun.Glob
  export type Patterns = Pattern | Pattern[]
  export type PatternInfo = {
    folder: string
    ext?: MixedArray<string>
    exclude?: Glob.Patterns
  }

  export type ArrayOfGlobs = {
    globs: Bun.Glob[]
  } & Bun.Glob

  export function pattern(patternInfo: PatternInfo): Bun.Glob {
    let { folder, ext, exclude } = patternInfo

    ext = toArray(ext)
    folder = folder ? `${safeResolve(folder)}/` : ''
    ext = ext.length > 0 ? `**/*.{${ext.join(',')}}` : '**/*'
    const excludeGlob = fromArray(toArray(exclude))
    const globPattern = from(folder + ext)

    return {
      async *scan(options) {
        for await (const entry of globPattern.scan(options)) {
          if (excludeGlob.match(entry)) continue
          yield entry
        }
      },

      match(path: string) {
        return globPattern.match(path) && !excludeGlob.match(path)
      },

      *scanSync(options) {
        const entries = globPattern.scanSync(options)
        for (const entry of entries) {
          if (excludeGlob.match(entry)) continue
          yield entry
        }
      },
    }
  }

  export function from(pattern: Pattern): Bun.Glob {
    if (pattern instanceof Bun.Glob) return pattern
    return new Bun.Glob(pattern)
  }

  export function match(globs: Patterns, path: string): boolean {
    return fromArray(toArray(globs)).match(safeResolve(path))
  }

  export function strings(...patterns: string[]): Bun.Glob {
    // No empty-pattern fallback: the braces make `pattern` at least `"{}"`, so
    // the length check it used to carry could never be false.
    return new Bun.Glob(`{${patterns.join(',')}}`)
  }

  export function fromArray(globs: Pattern[]): ArrayOfGlobs {
    const pattern: Bun.Glob[] = []
    const strings: string[] = []

    for (const p of globs) {
      if (p instanceof Bun.Glob) pattern.push(p)
      else if (is.string(p)) strings.push(p)
    }

    if (strings.length) pattern.push(Glob.strings(...strings))

    return {
      globs: pattern,
      match(path: string) {
        for (const g of this.globs) if (g.match(path)) return true
        return false
      },
      async *scan(options) {
        for (const g of this.globs) yield* g.scan(options)
      },
      *scanSync(options) {
        for (const g of this.globs) yield* g.scanSync(options)
      },
    }
  }

  export function patterns(...patterns: Pattern[]): ArrayOfGlobs {
    return fromArray(patterns)
  }

  export function fromExt(ext: MixedArray<string>, root = ''): Bun.Glob {
    ext = toArray(ext)
    root = root ? `${safeResolve(root)}/` : ''
    if (ext.length === 0) return new Bun.Glob('')
    return new Bun.Glob(`${root}**/*.{${ext.join(',')}}`)
  }
}

export namespace FileSystem {
  // Naming, not constraint — `string & {}` is `string`. These document what a
  // parameter means at its declaration, which earns their keep. Four more
  // (`RequestPath`, `DirectoryPath`, `FileName`, `FileExtension`) documented
  // nothing, because nothing ever referenced them.
  export type AbsolutePath = string & {}
  export type RelativePath = string & {}

  export async function* glob(pattern: Glob.Pattern, exclude?: Glob.Patterns) {
    const glob = Glob.from(pattern)
    const excludeGlob = Glob.fromArray(toArray(exclude))

    for await (const entry of glob.scan()) {
      if (excludeGlob.match(entry)) continue
      yield entry as AbsolutePath
    }
  }

  export const resolve = safeResolve
  export const cwd = safeResolve(process.cwd())
  export const parse = parsedPath
  export function dirname(path: string) {
    return nodeDirname(path).replace(/\\/g, '/')
  }
  export function relative(from: string, to: string) {
    return nodeRelative(from, to).replace(/\\/g, '/')
  }

  /**
   * Reads as UTF-8 text. Without the encoding this returns a Buffer, which
   * every caller then hands to `JSON.parse` — legal at runtime because it
   * coerces, but a type error at each call site, papered over in one of them
   * with `as any`.
   */
  export function readFileSync(path: string): string | null {
    if (!exists(path)) return null
    return fsRfs(path, 'utf8')
  }

  export async function isDir(path: string) {
    if (!exists(path)) return false
    return (await Try(() => Bun.file(path).stat()))?.isDirectory() || false
  }

  export function exists(path: string | Bun.BunFile): boolean {
    path = typeof path === 'string' ? path : path.name || ''
    const file = Bun.file(path)
    const lastMod = file.lastModified
    return Boolean((lastMod && lastMod < Date.now()) || file.size > 0)
  }

  export function existsSync(path: string): boolean {
    return nodeExistsSync(path)
  }

  /**
   * True only for an existing regular *file* — a directory answers false.
   * Sync because `findDynamicRoute` (a sync hot-path scan) is a caller; one
   * stat, no BunFile allocation.
   */
  export function isFileSync(path: string): boolean {
    return nodeStatSync(path, { throwIfNoEntry: false })?.isFile() ?? false
  }

  /**
   * Parent directory of an **already-normalised** absolute path — the output
   * shape `safeResolve` produces: forward slashes, no `.`/`..` segments, no
   * trailing slash except at a root.
   *
   * Only correct for that input shape, which is why it is not exported.
   * `isForbidden` is the sole caller and it normalises before the first call.
   */
  function parentOf(path: string): string {
    const idx = path.lastIndexOf('/')
    if (idx < 0) return path
    // POSIX root: the parent of `/a` is `/`, not the empty string.
    if (idx === 0) return '/'
    // Windows drive root: the parent of `C:/a` is `C:/`, not `C:`.
    //
    // Both of these branches are defensive rather than covered. `isForbidden`
    // stops as soon as the walk leaves `root`, and every root it is called
    // with is a real serve directory well below a filesystem root, so the walk
    // never reaches one — dropping them both leaves the equivalence test in
    // `fs.test.ts` green. They are kept so `parentOf` is correct as written
    // rather than correct only for its current caller.
    if (path.charCodeAt(idx - 1) === 58 /* ':' */) return path.slice(0, idx + 1)
    return path.slice(0, idx)
  }

  /**
   * True when `pathToCheck`, or any directory between it and `root`, holds a
   * `.forbidden` marker.
   *
   * This is a security guard, and it runs several times per request — from
   * `router.ts` before anything else, then again from `getStatic`, `getRoute`
   * (once per level of a nested route) and the dynamic-route cache. Each call
   * walks every directory between the target and the serve root, so the
   * per-level cost is multiplied twice over.
   *
   * The walk used to call `safeResolve` twice per level, once to build
   * `<dir>/.forbidden` and once to step to the parent. Both are `node:path`
   * `resolve`, which on Bun/Windows measures **~16-20us** — roughly 100x
   * `path.dirname` (~0.2us), independent of the filesystem and of where the
   * cwd lives, and not explained by native-call overhead (`Bun.nanoseconds()`
   * is 0.045us). A depth-4 walk therefore paid ten `resolve` calls.
   *
   * Since `curr` is normalised once on entry, every value it takes afterwards
   * is already in `resolve`'s own output shape, so both operations are exact
   * string edits. That takes a depth-4 walk from ten `resolve` calls to two
   * and leaves one `existsSync` per level as the only remaining syscall.
   * `fs.test.ts` pins the two implementations as equivalent.
   *
   * The entry normalisation stays: `pathToCheck` reaches here straight from a
   * URL pathname in `router.ts`, before any containment check, and collapsing
   * its dot segments is what makes the rest of the walk safe.
   *
   * The remaining `existsSync` per level is deliberately **not** memoised
   * *across requests*, which is the opposite call to the one `getMimeType`
   * below makes. The difference is not the key — both are ultimately derived
   * from a request path and both would need an `LRUCache` to stay bounded
   * under convention 6 — it is what a stale entry costs. A stale MIME type
   * serves the wrong `Content-Type`; a stale *negative* here serves a file an
   * operator has marked forbidden, which is the exact outcome the marker
   * exists to prevent.
   *
   * And there is nothing to invalidate against. Production has no watcher, and
   * the `SIGHUP` handler installed in `core/init.ts` is a deliberate no-op, so
   * a cached "not forbidden" would persist for the life of the process; a TTL
   * would only bound that window, not close it, and an operator dropping a
   * `.forbidden` file to pull content offline has no way to learn how long the
   * window is. The LRU also fails exactly when it would matter — a client
   * requesting varied paths evicts the useful upper-level entries, so the
   * hit rate collapses under the load that motivated caching in the first
   * place. `fs.test.ts` has a regression test that fails if this is added.
   *
   * What *is* deduplicated is the probe within one request. This guard runs
   * 4-6x per request over overlapping subtrees (router, `getStatic`, every
   * level of `getRoute`, the dynamic-route cache), each walk re-stating the
   * same directories at ~50us per miss on Bun/Windows. A marker dropped
   * *mid-request* has no meaningful semantics — the operator's guarantee is
   * "the next request sees it" — so the raw probe results live on the current
   * `hostStore` value (`HostContext.forbiddenProbes`), which worker.ts creates
   * per request and never reuses. No store (tests, direct calls, startup)
   * means no caching, bit-for-bit today's behavior.
   *
   * The memo stores the **per-level probe**, never the walk's verdict. The
   * verdict depends on `root`, and callers walk the same directories against
   * different roots (router uses the serve root, `getStatic` each candidate
   * root, `getRoute` its own). A verdict cache would also poison itself: a
   * walk that finds a marker at an upper level has recorded honest `false`
   * probes for every level below it, and treating those as "clean from here
   * up" would answer `false` for a subtree that is in fact forbidden.
   */
  export function isForbidden(pathToCheck: string, root: string): boolean {
    if (!pathToCheck || !root) return false
    let curr = safeResolve(pathToCheck)
    const normalizedRoot = safeResolve(root)

    const store = hostStore.getStore()
    const seen = store ? (store.forbiddenProbes ??= new Map()) : null

    while (
      curr.startsWith(normalizedRoot) &&
      curr.length >= normalizedRoot.length
    ) {
      // `curr` only ends in `/` when it is a root, where appending directly
      // would produce `C://.forbidden`.
      const forbiddenFile = curr.endsWith('/')
        ? `${curr}.forbidden`
        : `${curr}/.forbidden`

      let marked = seen?.get(forbiddenFile)
      if (marked === undefined) {
        marked = probeForbidden(forbiddenFile)
        seen?.set(forbiddenFile, marked)
      }
      if (marked) {
        return true
      }
      const parent = parentOf(curr)
      if (parent === curr) break
      curr = parent
    }
    return false
  }

  let probeForbidden: (path: string) => boolean = nodeExistsSync

  /**
   * Test seam (convention 9): lets `fs.test.ts` count the syscalls the
   * per-request dedup above is supposed to be saving, without module-mocking
   * `node:fs` — which is process-global and never unwinds.
   */
  export function __setForbiddenProbe(fn: (path: string) => boolean) {
    probeForbidden = fn
  }

  export function __resetForbiddenProbe() {
    probeForbidden = nodeExistsSync
  }

  export async function mkdir(path: string) {
    if (!exists(path)) await fsMkdir(path, { recursive: true })
  }

  export async function rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ) {
    await fsRm(path, options).catch(() => {})
  }

  export async function* readdir(info?: Glob.PatternInfo, files = false) {
    info ||= { folder: cwd }
    const glob = Glob.pattern(info)
    for await (let entry of glob.scan({ onlyFiles: files, absolute: true })) {
      entry = FileSystem.resolve(entry)
      const file = Bun.file(entry)
      yield {
        file,
        stat: await file.stat(),
        path: resolve(entry) as AbsolutePath,
      }
    }
  }

  export async function* files(info?: Glob.PatternInfo) {
    for await (const entry of readdir(info)) {
      if (entry.stat.isFile()) yield entry
    }
  }

  export function isCompressible(ext: string): boolean {
    const cleanExt = ext.toLowerCase().replace(/^\./, '')
    const mimeType = getMimeType(cleanExt)
    if (mimeType.startsWith('text/') || mimeType === 'application/json') {
      return true
    }

    return compressable.has(cleanExt)
  }

  function validCache(file: Bun.BunFile, sourceMtime: number | null): boolean {
    return exists(file) && (!sourceMtime || sourceMtime <= file.lastModified)
  }

  type FileContent = string | Uint8Array<ArrayBuffer> | ArrayBuffer

  /**
   * Builds currently running, keyed on the resolved raw path.
   *
   * `validCache` is a pure filesystem test with no record of work in progress,
   * so N concurrent first-hits on a cold cache each saw "not cached", each ran
   * `compiler()`, and each wrote the same three paths. Measured: 8 concurrent
   * callers produced 8 compiler invocations. Every `.ts`/`.tsx`/`.vue` asset
   * goes through here, so a traffic burst on a cold cache — or a cluster whose
   * workers share one cache directory — paid the full transpile *plus* gzip
   * *and* zstd once per concurrent request.
   *
   * Same memoised-promise idiom as `initDB`, `setupPlugins` and
   * `getTranspiler`, keyed rather than singular, and deleted in a `finally` so
   * a failed build is retried by the next caller rather than remembered. It is
   * bounded by construction (convention 6): an entry exists only while its own
   * build is running, never past it.
   *
   * The key is the path alone, not the path plus `sourceMtime`. A caller that
   * joins mid-build can therefore receive a build started for a marginally
   * older mtime — a window only as wide as one compile, which the next request
   * re-validates and rebuilds. Including the mtime would close that window by
   * letting two builds of the same file race each other onto the same three
   * output paths, which is the worse trade.
   */
  const inFlightBuilds = new Map<string, Promise<Bun.BunFile | null>>()

  export function getOrCreateCachedFile(
    cacheDir: string,
    cacheName: string,
    sourceMtime: number | null,
    compiler: () => MixedPromise<FileContent | null>,
    compress = true,
  ): Promise<Bun.BunFile | null> {
    const rawPath = resolve(cacheDir, cacheName)

    const pending = inFlightBuilds.get(rawPath)
    if (pending) return pending

    // No `await` between the lookup above and the insert below: that is the
    // whole of the mutual exclusion, and adding one reopens the bug.
    const task = buildCachedFile(
      cacheDir,
      cacheName,
      rawPath,
      sourceMtime,
      compiler,
      compress,
    ).finally(() => inFlightBuilds.delete(rawPath))

    inFlightBuilds.set(rawPath, task)
    return task
  }

  async function buildCachedFile(
    cacheDir: string,
    cacheName: string,
    rawPath: string,
    sourceMtime: number | null,
    compiler: () => MixedPromise<FileContent | null>,
    compress: boolean,
  ): Promise<Bun.BunFile | null> {
    const ext = parse(cacheName).ext
    const compressible = compress && isCompressible(ext)

    const rawFile = Bun.file(rawPath)

    if (compressible) {
      for (const { ext: compExt } of COMPRESSION_MAP) {
        const compFile = Bun.file(`${rawPath}${compExt}`)
        if (validCache(compFile, sourceMtime)) return compFile
      }

      const content = await compiler()
      if (content == null) return null

      // Only on the build path: a warm hit was paying this stat on every
      // request for nothing — the directory necessarily exists if the cached
      // file it holds just validated.
      await mkdir(cacheDir)

      // Same cutoff as `ETag.sendText`: a cold-cache burst is exactly when
      // the event loop is busiest, so large payloads compress on the pool;
      // below the cutoff the sync stall is smaller than the dispatch cost.
      const contentSize =
        typeof content === 'string' ? content.length : content.byteLength

      await Promise.all([
        rawFile.write(content),
        ...COMPRESSION_MAP.map(async ({ ext, compress, compressAsync }) => {
          const compressedContent =
            contentSize >= ASYNC_COMPRESSION_MIN
              ? await compressAsync(content)
              : (compress(content) as any)
          const compressedFile = Bun.file(`${rawPath}${ext}`)
          return compressedFile.write(compressedContent)
        }),
      ])

      return Bun.file(rawPath + COMPRESSION_MAP[0].ext)
    }

    // The mirror of the compressed branch's check above. Without it a
    // non-compressible entry (a .woff2 from the gstatic proxy, say) was
    // rebuilt — for fonts, re-fetched upstream — on every single request.
    if (validCache(rawFile, sourceMtime)) return rawFile

    const content = await compiler()
    if (content == null) return null
    await mkdir(cacheDir)
    await rawFile.write(content)
    return rawFile
  }

  /**
   * The extension→MIME mapping is static, but resolving it allocates a
   * `Bun.BunFile` every call — ~1.4us, on the path of every static-file and
   * compressed-asset response. Memoised behind an `LRUCache` rather than a
   * plain Map because `ext` is ultimately derived from the request path, and
   * an unbounded map keyed on client-supplied input is exactly what
   * convention 6 forbids.
   */
  const mimeTypes = new LRUCache<string, string>(256)

  export function getMimeType(ext: string): string {
    const cached = mimeTypes.get(ext)
    if (cached !== undefined) return cached

    const type = Bun.file(`dummy.${ext}`).type || 'application/octet-stream'
    mimeTypes.set(ext, type)
    return type
  }
}

export { FileSystem as fs }
