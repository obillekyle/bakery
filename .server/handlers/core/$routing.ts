import Bakery from '@server/core'
import { fs } from '@server/utils'
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
  dir: fs.AbsolutePath = Bakery.serveRoot,
  root: fs.AbsolutePath = Bakery.serveRoot,
  options: RouteScanOptions = {},
): Promise<Handler.Route.Info | null> {
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

    if (first !== 'index') {
      const targetDir = fs.resolve(dir, first)
      if (fs.isForbidden(targetDir, root)) return null
      const route = await getRoute('', exts, targetDir, root, options)
      if (route) return route
    }
  }

  if (count > 1) {
    const targetDir = fs.resolve(dir, first)
    if (fs.isForbidden(targetDir, root)) return null
    return await getRoute(pathArr, exts, targetDir, root, options)
  }
  return null
}
