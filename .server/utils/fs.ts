import { existsSync as nodeExistsSync } from 'node:fs'
import { mkdir as fsMkdir, rm as fsRm } from 'node:fs/promises'
import { relative as nodeRelative, resolve } from 'node:path'
import { parse as parsedPath } from 'node:path/posix'
import { is, Try } from './common'

export const COMPRESSION_MAP = [
  { encoding: 'zstd', ext: '.zst', compress: Bun.zstdCompressSync },
  { encoding: 'gzip', ext: '.gz', compress: Bun.gzipSync },
]

type MixedArray<T> = T | T[]

function toArray<T>(val?: MixedArray<T>): T[] {
  if (val === undefined) return []
  return Array.isArray(val) ? val : [val]
}

function safeResolve(...paths: string[]): FileSystem.AbsolutePath {
  return resolve(...paths).replace(/\\/g, '/')
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
    const pattern = `{${patterns.join(',')}}`
    return pattern.length ? new Bun.Glob(pattern) : new Bun.Glob('')
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
  export type AbsolutePath = string & {}
  export type RelativePath = string & {}
  export type RequestPath = string & {}
  export type DirectoryPath = string & {}
  export type FileName = string & {}
  export type FileExtension = string & {}

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
  export function relative(from: string, to: string) {
    return nodeRelative(from, to).replace(/\\/g, '/')
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

  export function isForbidden(pathToCheck: string, root: string): boolean {
    if (!pathToCheck || !root) return false
    let curr = safeResolve(pathToCheck)
    const normalizedRoot = safeResolve(root)

    while (curr.startsWith(normalizedRoot) && curr.length >= normalizedRoot.length) {
      const forbiddenFile = safeResolve(curr, '.forbidden')
      if (nodeExistsSync(forbiddenFile)) {
        return true
      }
      const parent = safeResolve(curr, '..')
      if (parent === curr) break
      curr = parent
    }
    return false
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

  export async function getOrCreateCachedFile(
    cacheDir: string,
    cacheName: string,
    sourceMtime: number | null,
    compiler: () => MixedPromise<FileContent | null>,
    compress = true,
  ) {
    const ext = parse(cacheName).ext
    const compressible = compress && isCompressible(ext)

    const rawPath = resolve(cacheDir, cacheName)
    const rawFile = Bun.file(rawPath)

    await mkdir(cacheDir)

    if (compressible) {
      for (const { ext: compExt } of COMPRESSION_MAP) {
        const compFile = Bun.file(`${rawPath}${compExt}`)
        if (validCache(compFile, sourceMtime)) return compFile
      }

      const content = await compiler()
      if (content == null) return null

      await Promise.all([
        rawFile.write(content),
        ...COMPRESSION_MAP.map(({ ext, compress }) => {
          const compressedContent = compress(content) as any
          const compressedFile = Bun.file(`${rawPath}${ext}`)
          return compressedFile.write(compressedContent)
        }),
      ])

      return Bun.file(rawPath + COMPRESSION_MAP[0].ext)
    }

    const content = await compiler()
    if (content == null) return null
    await rawFile.write(content)
    return rawFile
  }

  export function getMimeType(ext: string): string {
    const fileDummy = Bun.file(`dummy.${ext}`)
    return fileDummy.type || 'application/octet-stream'
  }
}

export { FileSystem as fs }
