import { Strings } from '@server/cache/string'
import { Bakery } from '@server/core/bakery'
import { PluginHooks } from '@server/core/plugins'
import { is } from '@server/utils/common'
import { FileSystem as fs } from '@server/utils/fs'

const RX_IMPORT =
  /import\s+(?:(?:\*\s+as\s+)?([a-zA-Z_$\d\s{},/*]+?)\s+from\s+)?['"]([^'"]+?\.([a-zA-Z0-9]+))['"](?:\s+(?:with|assert)\s*\{[^}]+\})?\s*;?/gm

let bakeryVersion = '1.0.0'
try {
  const pkgPath = Bun.resolveSync('package.json', Bakery.root || process.cwd())
  const content = fs.readFileSync(pkgPath)
  if (content) bakeryVersion = JSON.parse(content).version || '1.0.0'
} catch {}

const defines = {
  'import.meta.env.DEV': JSON.stringify(!!import.meta.env.DEV),
  'import.meta.env.PROD': JSON.stringify(!import.meta.env.DEV),
  'import.meta.env.WORKER': JSON.stringify(!!import.meta.env.WORKER),
  'import.meta.env.MODE': JSON.stringify(import.meta.env.MODE || 'production'),
  'import.meta.env.BAKERY_VERSION': JSON.stringify(bakeryVersion),
}

let transpilerInstance: Bun.Transpiler | null = null
function getTranspiler() {
  if (!transpilerInstance) {
    transpilerInstance = new Bun.Transpiler({
      loader: 'ts',
      inline: true,
      trimUnusedImports: false,
      minifyWhitespace: true,
      target: 'browser',
      deadCodeElimination: false,
      define: defines,
    })
  }
  return transpilerInstance
}

let virtualIdCounter = 0
function nextVirtualId(): string {
  return (++virtualIdCounter).toString(36)
}

function preprocessImports(source: string, filePath: fs.AbsolutePath): string {
  const fileDir = fs.resolve(filePath)

  const matches = [...source.matchAll(RX_IMPORT)]

  for (const [string, varName, importPath, ext] of matches) {
    const assetPath = fs.resolve(fileDir, importPath)
    const id = Strings.getKey(assetPath) || `${Date.now()}_${nextVirtualId()}.${ext}`

    const url = `/_virtual/${id}`
    const quotedUrl = JSON.stringify(url)

    if (ext !== 'css' && ext !== 'json') continue

    const replacement = varName
      ? `const ${varName} = await Bakery.virtual(${quotedUrl});`
      : `await Bakery.virtual(${quotedUrl});`

    source = source.replace(string, replacement)
    Strings.set(url, assetPath)
  }

  return source
}

export async function compileText(source: string, path?: fs.AbsolutePath) {
  if (!path) {
    try {
      const content = await getTranspiler().transform(source)
      return content
    } catch (err) {
      console.error(`[Compiler] Error compiling source:`, err)
      return source
    }
  }

  source = preprocessImports(source, path)
  const content = await getTranspiler().transform(source)
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

        return `${keyword}${spacing}${quote}${importPath}${isDir ? '/index' : ''}.js${quote}${closing}`
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
    define: defines,
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
