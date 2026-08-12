import Bakery from '../../core'
import { fs } from '../../utils'
import { type Handler, RouteData } from './$base'

const GETFILE = (dir: fs.AbsolutePath) => ({
  absolute: true,
  cwd: dir,
  dot: true,
  onlyFiles: true,
})

export type RouteScanOptions = {
  staticOnly?: boolean
  dynamicOnly?: boolean
}

// `[!.]` keeps catch-alls (`[...name]`) out of the single-param globs: they
// are matched separately, and last — a catch-all is the weakest route form,
// consulted only after specific files, single-param siblings and child-index
// descent have all missed.
const catchAllGlob = (ext: string) => new Bun.Glob(`[[]...*${ext || '.*'}`)

// The single-param route forms, in the order they are tried: `[name].ext`
// first, then the escaped-literal `*.ext`. Built here rather than twice inside
// `routeGlobs` — the `dynamicOnly` branch and the combined branch returned
// character-identical pairs, and the two must stay in step or a route form
// resolves under one caller and not the other. A function, not a hoisted
// constant: `ext` varies per handler, and `staticOnly` returns before it needs
// them at all.
const dynamicGlobs = (ext: string) => [
  new Bun.Glob(`[[][!.]*${ext || '.*'}`),
  new Bun.Glob(`\\*${ext || '.*'}`),
]

const routeGlobs = (
  first: string,
  ext: string,
  exts: string[],
  options: RouteScanOptions = {},
) => {
  if (options.dynamicOnly) {
    return dynamicGlobs(ext)
  }

  const hasExt = Boolean(fs.parse(first).ext)
  const valid =
    !hasExt || exts.length === 0 || exts.some(e => first.endsWith(`.${e}`))
  const stem = fs.parse(first).name

  const staticGlobs: Bun.Glob[] = []
  if (valid) {
    staticGlobs.push(new Bun.Glob(hasExt ? first : first + ext))
  }
  if (hasExt && ext && !valid) {
    staticGlobs.push(new Bun.Glob(stem + ext))
  }

  if (options.staticOnly) {
    return staticGlobs
  }

  return [...staticGlobs, ...dynamicGlobs(ext)]
}

/**
 * The catch-all fallback for one directory level: `dir/[...name].ext`,
 * containment-checked like every other candidate. Skipped for `staticOnly`
 * (the caller wants a literal file), and it *yields to any real file*: when
 * the request's remaining segments name an existing file under `dir` —
 * whatever its extension — the catch-all declines, so a lower-priority
 * handler (TSHandler, StaticHandler) can serve the file itself. A directory
 * is not a file and does not trigger the yield. `findDynamicRoute` applies
 * the same rule on the cached path; the two must agree.
 */
/**
 * Does the requested path name a file some handler serves at that URL?
 *
 * The "a real file always beats a catch-all" rule used to stat the literal
 * path only, which misses every *compiled* URL: `TSHandler` serves
 * `provides.ts` at `/teacher/provides` and `/teacher/provides.js`, so neither
 * spelling named a file on disk and a Vue catch-all above it (priority 58 vs
 * 50) served HTML to a browser that asked for a module. The probe now also
 * tries the registered dynamic extensions against the extensionless base —
 * the same mapping the serving handlers apply, read from the live registry so
 * a plugin's extension (`.vue`) counts without core naming it.
 *
 * The caller clamps `target` inside the root before asking; appending an
 * extension cannot escape it.
 */
export function servedSourceExists(target: string): boolean {
  if (fs.isFileSync(target)) return true

  const base = target.endsWith('.js') ? target.slice(0, -3) : target
  for (const handler of Bakery.handlers.fetch.keys()) {
    let exts: unknown
    try {
      exts = (handler as { config?: { ext?: unknown } }).config?.ext
    } catch {
      // A config getter that needs state this process lacks — a handler with
      // no ext table cannot claim a source file either way.
      continue
    }
    if (!Array.isArray(exts)) continue
    for (const ext of exts) {
      if (fs.isFileSync(`${base}.${ext}`)) return true
    }
  }

  return false
}

async function getCatchAllRoute(
  ext: string,
  dir: fs.AbsolutePath,
  root: fs.AbsolutePath,
  restSegments: string[],
): Promise<Handler.Route.Info | null> {
  const found = await catchAllGlob(ext)
    .scan(GETFILE(dir))
    .next()
    .catch(() => null)
  if (!found || found.done || !found.value) return null

  if (restSegments.length) {
    const target = fs.resolve(dir, restSegments.join('/'))
    // Stat only inside `dir`. A rest containing `..` resolves outside it, and
    // statting there would make this yield a boolean existence probe for any
    // path on the filesystem — the 404-vs-render difference is observable.
    // URL parsing normalises `..` and `%2e%2e` away, so no HTTP request
    // reaches here with one; this closes the door for any caller that skips
    // that normalisation. An escape skips the yield rather than refusing, so
    // the catch-all answers exactly as it did before the yield rule existed.
    // `dir` comes from `fs.resolve`, so the separator-suffixed prefix test is
    // exact — plain `startsWith(dir)` would also accept a sibling directory
    // whose name merely begins with it.
    if (
      (target === dir || target.startsWith(`${dir}/`)) &&
      servedSourceExists(target)
    ) {
      return null
    }
  }

  const file = fs.resolve(found.value)
  if (fs.isForbidden(file, root)) return null
  const info = new RouteData.Info(file, fs.relative(root, file))

  // A bare-directory request (`/docs` with no index) reaches here with no
  // rest segments, and only the `[...name!]` spelling opted into claiming
  // it — the plain form keeps requiring at least one segment.
  if (!restSegments.length && !info.optionalCatchAll) return null

  return info
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: request-to-route dispatcher
export async function getRoute(
  pathOrArr: string | string[],
  exts: string[] = [],
  dir?: fs.AbsolutePath,
  root?: fs.AbsolutePath,
  options: RouteScanOptions = {},
): Promise<Handler.Route.Info | null> {
  // Both used to default to `Bakery.serveRoot` independently — two reads of
  // the config getter (an AsyncLocalStorage getStore each) when a caller
  // omits both. One read now covers whichever is missing; the values are
  // unchanged.
  if (dir === undefined || root === undefined) {
    const serveRoot = Bakery.serveRoot
    dir ??= serveRoot
    root ??= serveRoot
  }

  if (fs.isForbidden(dir, root)) return null

  let pathArr = Array.isArray(pathOrArr)
    ? [...pathOrArr]
    : pathOrArr.split('/').filter(Boolean)
  exts = exts.filter(Boolean).map(e => e.replace(/^\./, ''))

  if (pathArr.length === 0) {
    pathArr = ['index']
  }

  const count = pathArr.length
  const first = pathArr.shift() ?? ''
  const ext = exts.length ? `.{${exts.join(',')}}` : ''
  const scanOptions = GETFILE(dir)
  const globs = routeGlobs(first, ext, exts, options)

  if (count === 1) {
    let file: string | null = null

    for (const glob of globs) {
      const globFile = await glob
        .scan(scanOptions)
        .next()
        .catch(() => null)
      if (!globFile || globFile.done || !globFile.value) continue

      file = fs.resolve(globFile.value)
      if (fs.isForbidden(file, root)) {
        file = null
        continue
      }
      break
    }

    if (file) return new RouteData.Info(file, fs.relative(root, file))

    // No containment check before either recursion: the callee's first
    // statement is `isForbidden(dir, root)` with these exact arguments, and its
    // `null` reaches the same `return null` this function ends on. Checking
    // here as well made every level of a nested route pay two identical
    // directory tree-walks — and `isForbidden` walks from the file to the root
    // doing an existsSync at each level, so that is the most expensive thing
    // this function does. `src/tests/forbidden.test.ts` pins both branches.
    if (first !== 'index') {
      const targetDir = fs.resolve(dir, first)
      const route = await getRoute('', exts, targetDir, root, options)
      if (route) return route
    }

    // `first === 'index'` is the bare-directory request (`/docs` arrives here
    // as an injected 'index' segment, after no index file matched). The plain
    // `[...name]` pattern requires at least one rest segment and cannot claim
    // it; `[...name!]` exists to — `getCatchAllRoute` tells them apart.
    if (!options.staticOnly) {
      return await getCatchAllRoute(
        ext,
        dir,
        root,
        first === 'index' ? [] : [first],
      )
    }
  }

  if (count > 1) {
    const targetDir = fs.resolve(dir, first)
    const route = await getRoute(pathArr, exts, targetDir, root, options)
    if (route) return route

    // The walk above descends one real segment at a time and dead-ends when
    // the next directory does not exist — which for a catch-all request
    // (`/docs/a/b/c` against `docs/[...slug].tsx`) is the common case. Each
    // level unwinds through here, so the deepest existing directory gets the
    // first chance to claim the rest.
    if (!options.staticOnly) {
      return await getCatchAllRoute(ext, dir, root, [first, ...pathArr])
    }
    return null
  }
  return null
}
