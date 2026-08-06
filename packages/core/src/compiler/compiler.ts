import { Strings } from '../cache/string'
import { Bakery } from '../core/bakery'
import { PluginHooks } from '../core/plugins'
import { compLog, errorMsg } from '../logger/serve-log'
import { is } from '../utils/common'
import { FileSystem as fs } from '../utils/fs'
import type { MapOf } from '../types'

const RX_IMPORT =
  /import\s+(?:(?:\*\s+as\s+)?([a-zA-Z_$\d\s{},/*]+?)\s+from\s+)?['"]([^'"]+?\.([a-zA-Z0-9]+))['"](?:\s+(?:with|assert)\s*\{[^}]+\})?\s*;?/gm

/**
 * The build-time `define` table, resolved on first use rather than at module
 * evaluation.
 *
 * This used to be a top-level `await` reading `<cwd>/package.json`, which put a
 * filesystem read on the boot path of every process that loads this module —
 * and `handlers/assets/ts.ts` imports it, so that is every worker and every dev
 * restart. The value it produces is needed only when something actually
 * compiles; a production process serving out of a warm compile cache never
 * needs it at all.
 *
 * Memoised as a promise, not a value, so two concurrent first compiles share
 * one read instead of racing to do it twice.
 */
let definesPromise: Promise<MapOf<string>> | null = null

async function buildDefines(): Promise<MapOf<string>> {
  let bakeryVersion = '1.0.0'
  try {
    const file = await Bun.file(process.cwd() + '/package.json').json()
    if (file && file.version) bakeryVersion = file.version
  } catch {
    // No package.json in cwd, or it is unreadable. The version is cosmetic —
    // it lands in a banner and a build define — so the default above stands.
  }

  return {
    'import.meta.env.DEV': JSON.stringify(!!import.meta.env.DEV),
    'import.meta.env.PROD': JSON.stringify(!import.meta.env.DEV),
    'import.meta.env.WORKER': JSON.stringify(!!import.meta.env.WORKER),
    'import.meta.env.MODE': JSON.stringify(
      import.meta.env.MODE || 'production',
    ),
    'import.meta.env.BAKERY_VERSION': JSON.stringify(bakeryVersion),
  }
}

function getDefines(): Promise<MapOf<string>> {
  definesPromise ??= buildDefines()
  return definesPromise
}

let transpilerPromise: Promise<Bun.Transpiler> | null = null
function getTranspiler(): Promise<Bun.Transpiler> {
  transpilerPromise ??= getDefines().then(
    define =>
      new Bun.Transpiler({
        loader: 'ts',
        inline: true,
        trimUnusedImports: false,
        minifyWhitespace: true,
        target: 'browser',
        deadCodeElimination: false,
        define,
      }),
  )
  return transpilerPromise
}

let virtualIdCounter = 0
function nextVirtualId(): string {
  return (++virtualIdCounter).toString(36)
}

function preprocessImports(source: string, filePath: fs.AbsolutePath): string {
  const fileDir = fs.resolve(filePath)

  const matches = [...source.matchAll(RX_IMPORT)]

  for (const [string, varName, importPath, ext] of matches) {
    if (ext !== 'css' && ext !== 'json') continue

    const assetPath = fs.resolve(fileDir, importPath)

    // The key is the bare id, never the `/_virtual/` URL. Storing the full URL
    // meant getKey() returned an already-prefixed value that got prefixed again
    // on the next compile — which both threw a StringCache collision and left
    // VirtualAssetHandler (which looks up by bare id) unable to resolve it.
    const id =
      Strings.getKey(assetPath) || `${Date.now()}_${nextVirtualId()}.${ext}`

    const quotedUrl = JSON.stringify(`/_virtual/${id}`)

    const replacement = varName
      ? `const ${varName} = await Bakery.virtual(${quotedUrl});`
      : `await Bakery.virtual(${quotedUrl});`

    source = source.replace(string, () => replacement)
    Strings.set(id, assetPath)
  }

  return source
}

export async function compileText(source: string, path?: fs.AbsolutePath) {
  if (!path) {
    try {
      const content = await (await getTranspiler()).transform(source)
      return content
    } catch (err) {
      compLog.COMPILE_SOURCE_FAIL({ error: errorMsg(err) })
      return source
    }
  }

  source = preprocessImports(source, path)
  const content = await (await getTranspiler()).transform(source)
  const importRegex = /\b(from|import)(\s*\(?\s*)(["'])([^"']+)\3(\)?)/g
  const matches = [...content.matchAll(importRegex)]

  if (!matches.length) return content

  const { dir } = fs.parse(path)
  const serveRoot = Bakery.serveRoot
  const importMap = Bakery.config.importMap
  const mapKeys = Object.keys(importMap)

  const replacements = await Promise.all(
    matches.map(
      async ([fullMatch, keyword, spacing, quote, importPath, closing]) => {
        const hasExtension = (importPath.split('/').pop() || '').includes('.')
        if (hasExtension) return fullMatch

        const prefix = mapKeys.find(k => importPath.startsWith(k))

        if (!prefix && !importPath.startsWith('.')) return fullMatch

        const targetPath = prefix
          ? fs.resolve(
              serveRoot,
              importMap[prefix],
              importPath.slice(prefix.length),
            )
          : fs.resolve(dir, importPath)

        const isDir = await fs.isDir(targetPath)

        return `${keyword}${spacing}${quote}${importPath}${isDir ? '/index' : ''}${quote}${closing}`
      },
    ),
  )
  let result = content.replace(importRegex, () => replacements.shift()!)
  return await PluginHooks.onCompile(result, path)
}

export async function compile(path: fs.AbsolutePath | Bun.BunFile) {
  if (!fs.exists(path))
    throw new Error(`File not found: ${is.string(path) ? path : path.name}`)

  path = typeof path === 'string' ? Bun.file(path) : path
  return compileText(await path.text(), path.name!)
}

type CompileResult = {
  success: boolean
  content?: string
  errors?: string[]
}

export async function bundleModule(
  path: fs.AbsolutePath,
): Promise<CompileResult> {
  const build = await Bun.build({
    entrypoints: [path],
    target: 'browser',
    format: 'esm',
    minify: import.meta.env.PROD,
    define: await getDefines(),
  })

  if (build.success && build.outputs.length > 0) {
    return { success: true, content: await build.outputs[0].text() }
  }

  const errors = build.logs
    .map(log => {
      if (!log) return ''
      if (is.string(log)) return log
      const msg = log.message || ''
      const pos = log.position
      if (!pos) return msg

      return `${pos.file || ''}:${pos.line || 0}:${pos.column || 0} - ${msg}`
    })
    .filter(Boolean)

  return { success: false, errors }
}
