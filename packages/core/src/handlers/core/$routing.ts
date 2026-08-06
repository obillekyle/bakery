import Bakery from '../../core'
import { fs } from '../../utils'
import { RouteData, type Handler } from './$base'

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

const routeGlobs = (
  first: string,
  ext: string,
  exts: string[],
  options: RouteScanOptions = {},
) => {
  if (options.dynamicOnly) {
    return [
      new Bun.Glob(`[[]*${ext || '.*'}`),
      new Bun.Glob(`\\*${ext || '.*'}`),
    ]
  }

  const hasExt = Boolean(fs.parse(first).ext)
  const valid = !hasExt || exts.length === 0 || exts.some(e => first.endsWith(`.${e}`))
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

  return [
    ...staticGlobs,
    new Bun.Glob(`[[]*${ext || '.*'}`),
    new Bun.Glob(`\\*${ext || '.*'}`),
  ]
}

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
    // this function does. `tests/forbidden.test.ts` pins both branches.
    if (first !== 'index') {
      const targetDir = fs.resolve(dir, first)
      const route = await getRoute('', exts, targetDir, root, options)
      if (route) return route
    }
  }

  if (count > 1) {
    const targetDir = fs.resolve(dir, first)
    return await getRoute(pathArr, exts, targetDir, root, options)
  }
  return null
}
