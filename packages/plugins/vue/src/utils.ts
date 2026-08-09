import {
  readdir as nodeReaddir,
  rename as nodeRename,
  unlink as nodeUnlink,
} from 'node:fs/promises'
import { LRUCache } from '@bakery/core/cache/lru'
import { Bakery } from '@bakery/core/core/bakery'
import { Logger } from '@bakery/core/logger'
import { fs, is, Try } from '@bakery/core/utils'
import type { ParsedCacheEntry, ServerResponseOptions, VueMeta } from './types'

const logger = new Logger('vue')

export let VUE_VERSION = 'vue'
export function initVueVersion() {
  try {
    const pkgPath = Bun.resolveSync('vue/package.json', process.cwd())
    const content = fs.readFileSync(pkgPath)
    if (content) {
      const pkg = JSON.parse(content)
      if (pkg?.version) VUE_VERSION = pkg.version
    }
  } catch {
    // Vue is resolved from the app's cwd and may not be installed there at
    // all. The pinned default is the fallback, and the caller renders either way.
  }
  return VUE_VERSION
}

export const RX_IMPORT_VUE_FILE =
  /(?:from\s+|import\s+|import\()(['"][^'"]*\.vue['"])/g
export const RX_EXPORT_BRACE = /\bexport\s*\{([\s\S]*?)\}/g
export const RX_EXPORT_HANGING = /\bexport\s+(const|let|var)\s+(\w+)\s*=\s*/g
export const RX_EXPORT_FUNCTION = /\bexport\s+(?:async\s+)?function\s+(\w+)/g
/** `export const fn = async (a) => {}` / `= function () {}` — callable, not data. */
export const RX_EXPORT_CALLABLE_CONST =
  /\bexport\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^)]*\)|\w+)\s*=>)/g
export const RX_TOP_LEVEL_IMPORT =
  /^\s*import\s*(?:(?:[\w_$*{},\s\n]+from\s*)?['"`][^'"`\n]+['"`]|['"`][^'"`\n]+['"`]);?/

export const cacheDir = fs.resolve(Bakery.cacheDir, 'vue')
export const VUE_SERVER_DATA_TOKEN = '__BAKERY_VUE_SERVER_DATA__'

/** Prefix for names the generated wrapper reserves, so user code can't collide. */
const INTERNAL_PREFIX = '__bkry_'
const SERVER_SCRIPT_TIMEOUT_MS = 5000

export const parsedCache = new LRUCache<string, ParsedCacheEntry>(1000)

/**
 * Escaping is owned by the framework, not by this plugin \u2014 core and other
 * plugins were importing it from here, which would make `@bakery/core` depend
 * on `@bakery/vue` once these ship as separate packages. Re-exported so this
 * plugin's own modules and tests keep their existing import path.
 */
export { escapeHtml, escapeScriptJson } from '@bakery/core/utils/http'

const RX_SERVER_SCRIPT_OPEN = /<script\b(?=[^>]*\bserver(?=[\s/>=]))[^>]*>/gi
const CLOSING_TAG = '</script'

/**
 * Find the `</script>` that actually closes a server block, skipping ones that
 * appear inside string literals, template literals, or comments. A plain
 * non-greedy regex stops at the first match — so server code containing
 * `"</script>"` would be cut short and its remainder left in the client bundle.
 */
function findServerScriptEnd(raw: string, start: number): number {
  let index = start

  while (index < raw.length) {
    const char = raw[index]
    const next = raw[index + 1]

    if (char === '/' && next === '/') {
      const nl = raw.indexOf('\n', index)
      index = nl === -1 ? raw.length : nl
      continue
    }

    if (char === '/' && next === '*') {
      const end = raw.indexOf('*/', index + 2)
      index = end === -1 ? raw.length : end + 2
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < raw.length) {
        if (raw[index] === '\\') {
          index += 2
          continue
        }
        if (raw[index] === char) break
        index += 1
      }
      index += 1
      continue
    }

    if (
      char === '<' &&
      raw.slice(index, index + CLOSING_TAG.length).toLowerCase() === CLOSING_TAG
    ) {
      return index
    }

    index += 1
  }

  return raw.length
}

/** Collect every `<script server>` block; a file may declare more than one. */
export function extractServerScripts(raw: string): {
  script: string
  clean: string
} {
  const blocks: string[] = []
  let clean = ''
  let cursor = 0

  RX_SERVER_SCRIPT_OPEN.lastIndex = 0
  let open: RegExpExecArray | null

  while ((open = RX_SERVER_SCRIPT_OPEN.exec(raw))) {
    const bodyStart = open.index + open[0].length
    const bodyEnd = findServerScriptEnd(raw, bodyStart)

    blocks.push(raw.slice(bodyStart, bodyEnd))
    clean += raw.slice(cursor, open.index)

    const tagEnd = raw.indexOf('>', bodyEnd)
    cursor = bodyEnd >= raw.length || tagEnd === -1 ? raw.length : tagEnd + 1
    RX_SERVER_SCRIPT_OPEN.lastIndex = cursor
  }

  clean += raw.slice(cursor)
  return { script: blocks.join('\n'), clean }
}

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

/**
 * The compiled server block runs from the cache directory, so relative imports
 * must be made absolute. `import(` is included because dynamic imports are the
 * normal way a server action pulls in an API handler.
 */
export function rewriteRelativeImports(
  code: string,
  filePath?: string,
): string {
  if (!filePath) return code
  const dir = fs.dirname(filePath)
  return code.replace(
    /(?:from\s+|import\s+|import\()(['"]\.[^'"]+['"])/g,
    (match, quotePath: string) => {
      const rel = quotePath.slice(1, -1)
      const abs = fs.resolve(dir, rel).replace(/\\/g, '/')
      return match.replace(quotePath, `'${abs}'`)
    },
  )
}

/**
 * Find where the expression starting at `start` ends. Tracks bracket depth and
 * skips strings/comments, so a multi-line object, function, or arrow body
 * survives intact — stopping at the first newline breaks all three.
 */
function findExpressionEnd(code: string, start: number): number {
  let depth = 0
  let index = start
  let sawBlock = false
  let lastMeaningful = ''
  const startsWithFunction = /^\s*(?:async\s+)?function\b/.test(
    code.slice(start),
  )

  while (index < code.length) {
    const char = code[index]
    const next = code[index + 1]

    if (char === '/' && next === '/') {
      const nl = code.indexOf('\n', index)
      index = nl === -1 ? code.length : nl
      continue
    }

    if (char === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2)
      index = end === -1 ? code.length : end + 2
      continue
    }

    if (char === '"' || char === "'" || char === '`') {
      index += 1
      while (index < code.length) {
        if (code[index] === '\\') {
          index += 2
          continue
        }
        if (code[index] === char) break
        index += 1
      }
      index += 1
      lastMeaningful = char
      continue
    }

    if (char === '(' || char === '[' || char === '{') {
      depth += 1
      index += 1
      lastMeaningful = char
      continue
    }

    if (char === ')' || char === ']' || char === '}') {
      depth -= 1
      if (depth <= 0 && char === '}') sawBlock = true
      index += 1
      lastMeaningful = char
      continue
    }

    if (char === ';' && depth <= 0) return index

    if (char === '\n' && depth <= 0) {
      // ASI: only end the expression here if it already looks complete.
      const incomplete =
        lastMeaningful === '' ||
        '+-*/%=&|^<>,?:.({['.includes(lastMeaningful) ||
        (startsWithFunction && !sawBlock)
      if (!incomplete) return index
      index += 1
      continue
    }

    if (!/\s/.test(char)) lastMeaningful = char
    index += 1
  }

  return code.length
}

/**
 * Rewrite `export default <expr>` into a plain const. Evaluating it at the end
 * of the wrapper rather than inline puts value- and function-form defaults on
 * one code path and lets middleware gate both.
 */
function rewriteDefaultExport(body: string): {
  code: string
  hasDefault: boolean
} {
  const match = body.match(/\bexport\s+default\s+/)
  if (!match || match.index === undefined) {
    return { code: body, hasDefault: false }
  }

  const exprStart = match.index + match[0].length
  const exprEnd = findExpressionEnd(body, exprStart)
  const expr = body.slice(exprStart, exprEnd)

  const code =
    body.slice(0, match.index) +
    `const ${INTERNAL_PREFIX}defaultVal = ${expr};` +
    body.slice(exprEnd)

  return { code, hasDefault: true }
}

export function collectExportedFunctionNames(script: string): string[] {
  const names: string[] = []
  for (const m of script.matchAll(RX_EXPORT_FUNCTION)) names.push(m[1])
  for (const m of script.matchAll(RX_EXPORT_CALLABLE_CONST)) names.push(m[1])
  return [...new Set(names)]
}

export function compileServerBlock(
  serverScript: string,
  filePath?: string,
): string {
  let script = rewriteRelativeImports(serverScript, filePath)

  script = script
    .replace(/\bexport\s+type\s+\w+\s*=[\s\S]*?;/g, '')
    .replace(/\bexport\s+interface\s+\w+[\s\S]*?\}/g, '')

  const { imports, body } = extractImportsAndBody(script)

  const exportedFnNames = collectExportedFunctionNames(body)
  const { code: withDefault, hasDefault } = rewriteDefaultExport(body)
  let compiledBody = withDefault

  compiledBody = compiledBody.replace(
    /\bexport\s+(?=(?:async\s+)?function\b)/g,
    '',
  )

  compiledBody = compiledBody.replace(
    /\bexport\s+(const|let|var)\s+\{([^}]+)\}\s*=\s*([\s\S]+?)(?:;|\n|$)/g,
    (_, kind, dest, expr) => {
      const keys = dest
        .split(',')
        .map((k: string) => k.trim())
        .filter(Boolean)
      const assignments = keys
        .map((k: string) => `${INTERNAL_PREFIX}result['${k}'] = ${k};`)
        .join(' ')
      return `${kind} { ${dest} } = ${expr};\n${assignments}`
    },
  )

  compiledBody = compiledBody
    .replace(RX_EXPORT_HANGING, `$1 $2 = ${INTERNAL_PREFIX}result['$2'] = `)
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
          return `${trimmed}: ${trimmed}`
        })
        .filter(Boolean)
        .join(', ')
      return `Object.assign(${INTERNAL_PREFIX}result, { ${properties} })`
    })

  const fnAssignments = exportedFnNames
    .map(fn => `try { ${INTERNAL_PREFIX}result['${fn}'] = ${fn}; } catch {}`)
    .join('\n')

  // Only these names are reachable via `?__vue_action=`; anything else the
  // script exports stays server-side data.
  const actionAllowList = JSON.stringify(
    exportedFnNames.filter(fn => fn !== 'middleware' && fn !== 'default'),
  )

  const p = INTERNAL_PREFIX

  return `
  ${imports}

  const ${p}isResponseLike = (v: any) =>
    v instanceof Response ||
    (v && typeof v === 'object' && 'arrayBuffer' in v && 'size' in v)

  const ${p}actions = new Set(${actionAllowList})

  // NOTE: the top-level statements below run before middleware. Middleware can
  // stop the response but cannot stop top-level code from executing — put
  // auth-gated work inside an exported function, not at the top level.
  export default async function ${p}server(req: any, body: any, actionName?: string, actionArgs?: any[]) {
    const ${p}result: any = {}

    // The allow-list is static — it is this script's own exports — so it can
    // be answered before a line of the component runs. It used to be checked
    // after the body, which meant naming an action that does not exist still
    // executed every top-level statement in the file; with \`__vue_file\`
    // pointing at another component, that was a way to run one page's server
    // block from another page's route.
    //
    // It does sit ahead of middleware, so an unauthenticated caller can now
    // tell an unknown action name from a known one. That is the smaller leak:
    // the alternative is running the file to find out.
    if (actionName && !${p}actions.has(actionName)) {
      return { error: \`Action '\${actionName}' not found\` }
    }

    ${compiledBody}

    ${fnAssignments}

    if (typeof ${p}result['middleware'] === 'function') {
      const ${p}mwRes = await ${p}result['middleware'](req, body);
      if (${p}isResponseLike(${p}mwRes)) return ${p}mwRes;
    }

    if (actionName) {
      if (!${p}actions.has(actionName) || !Object.hasOwn(${p}result, actionName)) {
        return { error: \`Action '\${actionName}' not found\` }
      }
      const ${p}args = Array.isArray(actionArgs) ? actionArgs : []
      return await ${p}result[actionName](...${p}args)
    }
${
  hasDefault
    ? `
    let ${p}defaultRes: any = ${p}defaultVal;
    if (typeof ${p}defaultRes === 'function') {
      ${p}defaultRes = await ${p}defaultRes(req, body);
    }
    if (${p}isResponseLike(${p}defaultRes)) return ${p}defaultRes;
    if (typeof ${p}defaultRes === 'object' && ${p}defaultRes !== null) {
      Object.assign(${p}result, ${p}defaultRes);
    } else if (${p}defaultRes !== undefined) {
      ${p}result['default'] = ${p}defaultRes;
    }
`
    : ''
}
    return ${p}result
  }
  `
}

/** Drop stale compiled versions of the same source so the cache dir stays bounded. */
async function pruneServerCache(dir: string, id: string, keepName: string) {
  const entries = await Try(nodeReaddir(dir))
  if (!entries) return
  await Promise.all(
    entries
      .filter(
        name =>
          name.startsWith(`${id}_`) &&
          name.endsWith('.ts') &&
          name !== keepName,
      )
      .map(name => Try(nodeUnlink(fs.resolve(dir, name)))),
  )
}

const inFlightCompiles = new Map<string, Promise<void>>()
let tempCounter = 0

function writeServerModule(
  dir: string,
  cacheName: string,
  id: string,
  script: string,
  filePath?: string,
): Promise<void> {
  const cacheKey = fs.resolve(dir, cacheName)
  const pending = inFlightCompiles.get(cacheKey)
  if (pending) return pending

  const task = (async () => {
    await fs.mkdir(dir)
    // Write to a temp path then rename, so a concurrent request can never
    // import a half-written module.
    const tempPath = `${cacheKey}.${process.pid}.${tempCounter++}.tmp`
    await Bun.write(tempPath, compileServerBlock(script, filePath))
    const [renameError] = await Try.catch(nodeRename(tempPath, cacheKey))
    if (renameError) {
      await Bun.write(cacheKey, Bun.file(tempPath))
      await Try(nodeUnlink(tempPath))
    }
    await pruneServerCache(dir, id, cacheName)
  })().finally(() => inFlightCompiles.delete(cacheKey))

  inFlightCompiles.set(cacheKey, task)
  return task
}

export async function getServerResponse(options: ServerResponseOptions) {
  const { script, id, lastMod, req, body, filePath, actionName, actionArgs } =
    options
  if (!script.trim()) return {}

  const dir = fs.resolve(cacheDir, 'server')
  const cacheName = `${id}_${lastMod}.ts`
  const cacheKey = fs.resolve(dir, cacheName)

  if (!fs.exists(cacheKey)) {
    await writeServerModule(dir, cacheName, id, script, filePath)
  }

  const importUrl = Bun.pathToFileURL(cacheKey).href
  const [importError, mod] = await Try.catch(import(importUrl))
  const exported = mod?.default

  if (!exported) {
    logger.log(
      `Failed to load server script for ${id}: ${
        importError?.message || 'no default export'
      }`,
      'error',
    )
    return {}
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Server script execution timed out (${SERVER_SCRIPT_TIMEOUT_MS}ms limit)`,
            ),
          ),
        SERVER_SCRIPT_TIMEOUT_MS,
      )
    })
    const execPromise = Promise.resolve(
      is.function(exported)
        ? exported(req, body, actionName, actionArgs)
        : exported,
    )
    const params = await Promise.race([execPromise, timeoutPromise])

    if (
      params instanceof Response ||
      (params &&
        typeof params === 'object' &&
        'arrayBuffer' in params &&
        'size' in params)
    ) {
      return params
    }

    if (actionName !== undefined) {
      return params
    }

    return is.object(params) ? params : {}
  } catch (err: any) {
    logger.log(
      `Server script error in ${id}: ${err?.message || err} at ${req.url}`,
      'error',
    )
    return {}
  } finally {
    clearTimeout(timer)
  }
}

export function rewriteVueImports(code: string): string {
  return code.replace(
    RX_IMPORT_VUE_FILE,
    (match, quote: string) =>
      `${match.slice(0, -quote.length)}${quote.slice(0, -1)}?__vue_script=module${quote[0]}`,
  )
}

/**
 * A leading `<meta … />` directive. Quoted attribute values may contain `>`,
 * so plain `[^>]` would truncate the tag. Anchored: only the prologue counts.
 */
export const RX_VUE_META = /^<meta(?![\w-])((?:"[^"]*"|'[^']*'|[^>])*?)\/>/i
const RX_META_SKIPPABLE = /^\s+|^<!--[\s\S]*?-->/

export function parseVueMeta(raw: string): { meta: VueMeta; clean: string } {
  const meta: VueMeta = { moduleOnly: false, pageOnly: false, title: null }

  // Directives live in the file prologue only. Walking forward from the start
  // (rather than scanning the whole file) keeps a `<meta />` inside a template
  // or a script string from being treated as a directive.
  let index = 0
  let prologue = ''

  while (index < raw.length) {
    const rest = raw.slice(index)

    const skippable = rest.match(RX_META_SKIPPABLE)
    if (skippable) {
      prologue += skippable[0]
      index += skippable[0].length
      continue
    }

    const tag = rest.match(RX_VUE_META)
    if (!tag) break

    const attrs = tag[1]
    if (/\bmodule-only\b/i.test(attrs)) meta.moduleOnly = true
    if (/\bpage-only\b/i.test(attrs)) meta.pageOnly = true

    const titleMatch = attrs.match(
      /\btitle\s*=\s*"([^"]*)"|\btitle\s*=\s*'([^']*)'/i,
    )
    if (titleMatch) meta.title = titleMatch[1] ?? titleMatch[2]

    index += tag[0].length
  }

  return { meta, clean: prologue + raw.slice(index) }
}
