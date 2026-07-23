import { Bakery } from '@server/core/bakery'
import { fs } from '@server/utils'
import type { ParsedCacheEntry, ServerResponseOptions } from './types'

export let VUE_VERSION = 'vue'
export function initVueVersion() {
  try {
    const pkgPath = Bun.resolveSync('vue/package.json', process.cwd())
    const content = fs.readFileSync(pkgPath)
    if (content) {
      const pkg = JSON.parse(content)
      if (pkg?.version) VUE_VERSION = pkg.version
    }
  } catch {}
  return VUE_VERSION
}

export const RX_SERVER_SCRIPT = /<script\s+server\b[^>]*>([\s\S]*?)<\/script>/i
export const RX_IMPORT_VUE_FILE = /(['"][^'"]*\.vue['"])/g
export const RX_EXPORT_BRACE = /\bexport\s*\{([\s\S]*?)\}/g
export const RX_EXPORT_DEFAULT = /\bexport\s+default\s+/g
export const RX_EXPORT_HANGING = /\bexport\s+(const|let|var)\s+(\w+)\s*=\s*/g
export const RX_TOP_LEVEL_IMPORT =
  /^\s*import\s*(?:(?:[\w_$*{},\s\n]+from\s*)?['"`][^'"`\n]+['"`]|['"`][^'"`\n]+['"`]);?/

export const cacheDir = fs.resolve(Bakery.cacheDir, 'vue')

export const parsedCache = new Map<string, ParsedCacheEntry>()

export function extractImportsAndBody(code: string) {
  const imports: string[] = []

  const codeLength = code.length
  let index = 0
  let lastImportEnd = 0

  while (index < codeLength) {
    const remaining = code.slice(index)
    const wsMatch = remaining.match(/^\s+|^\/\/.*|^\/\*[\s\S]*?\*\//)
    if (wsMatch) {
      index += wsMatch[0].length
      continue
    }

    const importMatch = remaining.match(RX_TOP_LEVEL_IMPORT)
    if (importMatch && importMatch.index === 0) {
      imports.push(importMatch[0])
      index += importMatch[0].length
      lastImportEnd = index
    } else {
      break
    }
  }

  return { imports: imports.join('\n'), body: code.slice(lastImportEnd) }
}

export function compileServerBlock(serverScript: string): string {
  const { imports, body } = extractImportsAndBody(serverScript)
  const compiledBody = body
    .replace(RX_EXPORT_BRACE, (_, exportsContent) => {
      const properties = exportsContent
        .split(',')
        .map((part: string) => {
          const trimmed = part.trim()
          if (!trimmed) return ''
          if (trimmed.includes(' as ')) {
            const [local, alias] = trimmed.split(/\s+as\s+/)
            return `${alias}: ${local}`
          }
          return trimmed
        })
        .filter(Boolean)
        .join(', ')
      return `Object.assign(finalValue, { ${properties} })`
    })
    .replace(RX_EXPORT_DEFAULT, 'return ')
    .replace(RX_EXPORT_HANGING, "$1 $2 = finalValue['$2'] = ")

  return `
  ${imports}

  export default async function server(req: any, body: any) {
    const finalValue: any = {}
    
    ${compiledBody}

    return finalValue
  }
  `
}

export async function getServerResponse(options: ServerResponseOptions) {
  const { script, id, lastMod, req, body } = options
  if (!script.trim()) return {}
  const { is, Try } = await import('@server/utils')

  const dir = fs.resolve(cacheDir, 'server')
  const cacheKey = fs.resolve(dir, `${id}.ts`)
  const cacheFile = Bun.file(cacheKey)

  if (!fs.exists(cacheKey) || cacheFile.lastModified < lastMod) {
    await fs.mkdir(dir)
    await Bun.write(cacheKey, compileServerBlock(script))
  }

  const mod = await Try(import(`${cacheKey}?v=${lastMod}`))
  const exported = mod?.default

  const params = is.function(exported)
    ? await exported(req, body)
    : exported

  return is.object(params) ? params : {}
}

export function rewriteVueImports(code: string): string {
  return code.replace(
    RX_IMPORT_VUE_FILE,
    (_match, quote: string) =>
      `${quote.slice(0, -1)}?__vue_script=module${quote[0]}`,
  )
}
