import { LRUCache } from '@bakery-framework/core/cache/lru'
import { Bakery, hostKey } from '@bakery-framework/core/core/bakery'
import type { Handler } from '@bakery-framework/core/handlers'
import {
  beginPageRoute,
  DynamicErrorHandler,
  DynamicHandler,
} from '@bakery-framework/core/handlers'
import {
  fs,
  JsonResponseData,
  response,
  toHash,
} from '@bakery-framework/core/utils'
import { ETag, injectIfHtml } from '@bakery-framework/core/utils/http'

import {
  resolveActionTarget,
  validateActionRequest,
  validateActionTarget,
} from './actions'
import { serveVueChunk, VUE_CHUNK_PREFIX } from './chunks'
import {
  compileStyleBlock,
  compileVueFile,
  parseVue,
  vueBuildVariant,
} from './compile'
import { VUE_HTML_SHELL } from './shell'
import type { ParsedCacheEntry, VueMeta } from './types'
import {
  cacheDir,
  collectExportedFunctionNames,
  escapeHtml,
  escapeScriptJson,
  extractServerScripts,
  getServerResponse,
  parsedCache,
  parseSkeleton,
  parseVueMeta,
  RX_EXPORT_BRACE,
  RX_EXPORT_HANGING,
  rewriteVueImports,
  VUE_SERVER_DATA_TOKEN,
} from './utils'

function normalizePath(path: string) {
  return path.endsWith('.js') ? path.slice(0, -3) : path
}

const RX_SERVER_DATA_TOKEN = new RegExp(`\\b${VUE_SERVER_DATA_TOKEN}\\b`, 'g')

/**
 * Compiled module code with the server-data token still in place. Components
 * with a `<script server>` block get per-request data, so the code cannot be
 * cached on disk with the data baked in — but the expensive compile can be.
 */
const tokenizedModuleCache = new LRUCache<
  string,
  { lastMod: number; code: string }
>(500)

/**
 * Client-side stub for a server action: calls back into this route over HTTP.
 * Must be POST + JSON to satisfy the CSRF checks in `validateActionRequest`.
 */
function buildActionStub(fn: string, relPath: string) {
  const query = `?__vue_action=${encodeURIComponent(fn)}&__vue_file=${encodeURIComponent(relPath)}`
  return (
    `const ${fn} = async (...args) => { ` +
    `const res = await fetch(window.location.pathname + '${query}', { ` +
    `method: 'POST', headers: { 'Content-Type': 'application/json' }, ` +
    `body: JSON.stringify({ args }) }); ` +
    `const ct = res.headers.get('content-type') || ''; ` +
    `if (ct.includes('application/json')) { const json = await res.json(); ` +
    `return json.data !== undefined ? json.data : json; } ` +
    `return res; };`
  )
}

/**
 * Route path of the nearest `layout.vue`, walking from the page **file** up
 * to the serve root — the file, not the URL, so a catch-all page
 * (`admin/[...slug!].vue`) is wrapped by `admin/layout.vue` no matter how
 * deep the request path goes. Null when nothing is found, when the page
 * opted out with `<meta no-layout />`, or when the page *is* a layout —
 * layouts do not nest in v1, deliberately: nesting needs an ordering story
 * (which slot, whose styles win) that should be designed, not implied.
 */
function findLayoutRoute(filePath: string, meta: VueMeta): string | null {
  if (!meta.layout) return null

  const root = fs.resolve(Bakery.serveRoot)
  const file = fs.resolve(filePath)
  if (!file.startsWith(`${root}/`)) return null
  if (file.endsWith('/layout.vue')) return null

  let dir = file.slice(0, file.lastIndexOf('/'))
  while (dir === root || dir.startsWith(`${root}/`)) {
    const candidate = `${dir}/layout.vue`
    if (fs.isFileSync(candidate)) {
      return `/${fs.relative(root, candidate)}`
    }
    if (dir === root) break
    dir = dir.slice(0, dir.lastIndexOf('/'))
  }

  return null
}

export class VueHandler extends DynamicHandler {
  static get config() {
    return {
      ext: ['vue'],
      dir: Bakery.serveRoot,
    }
  }

  static get cacheDir() {
    return cacheDir
  }

  static async canHandle(path: string, req: Request) {
    if (path.startsWith(VUE_CHUNK_PREFIX)) return true
    if (path.endsWith('.vue')) return true
    if (path.endsWith('.js')) path = path.slice(0, -3)
    return await super.canHandle(path, req)
  }

  static handle = sharedHandler

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SFC parser
  static async parseVueFile(
    id: string,
    diskFile: Bun.BunFile,
    filePath: string,
    lastMod: number,
  ) {
    const cached = parsedCache.get(id)
    if (cached && cached.lastMod === lastMod) return cached

    const rawText = await diskFile.text()
    const { meta, clean: metaCleaned } = parseVueMeta(rawText)
    const { skeleton, clean: withoutSkeleton } = parseSkeleton(metaCleaned)
    const { script: serverScript, clean: withoutServer } =
      extractServerScripts(withoutSkeleton)
    let cleanContent = withoutServer

    if (serverScript.trim()) {
      const functionNames = collectExportedFunctionNames(serverScript)
      const dataNames: string[] = []

      for (const m of serverScript.matchAll(RX_EXPORT_HANGING)) {
        if (!functionNames.includes(m[2])) dataNames.push(m[2])
      }

      for (const m of serverScript.matchAll(RX_EXPORT_BRACE)) {
        for (const part of m[1].split(',')) {
          const t = part.trim()
          if (!t) continue
          const alias = t.includes(' as ') ? t.split(/\s+as\s+/)[1] : t
          if (!functionNames.includes(alias)) dataNames.push(alias)
        }
      }

      const scriptInjections: string[] = []
      if (dataNames.length) {
        scriptInjections.push(
          `const { ${dataNames.join(', ')} } = ${VUE_SERVER_DATA_TOKEN};`,
        )
      }

      if (functionNames.length) {
        const relPath = fs.relative(Bakery.serveRoot, filePath)
        for (const fn of functionNames) {
          scriptInjections.push(buildActionStub(fn, relPath))
        }
      }

      if (scriptInjections.length) {
        const langMatch = cleanContent.match(
          /<script\s+[^>]*\blang=["']([^"']+)["']/i,
        )
        const langAttr = langMatch ? ` lang="${langMatch[1]}"` : ''
        cleanContent = `<script${langAttr}>\n${scriptInjections.join(
          '\n',
        )}\n</script>\n${cleanContent}`

        // A component with a server block but no `<script setup>` used to
        // render blank: the injected block above has no `export default`, so
        // `assembleComponent` had nothing to rewrite into `const __sfc__ =`
        // and the module died with `ReferenceError: __sfc__ is not defined`.
        // The documented workaround was a setup block — so inject one. The
        // comment inside is load-bearing: the SFC parser *discards* a block
        // whose content is only whitespace, which is also why the workaround
        // had to be a non-empty block. It also makes the server exports
        // template-visible — compileScript only records plain-script bindings
        // when a setup block exists.
        if (!/<script\s[^>]*\bsetup\b|<script\s+setup/i.test(cleanContent)) {
          cleanContent += `\n<script setup${langAttr}>\n// injected: carries the server-data bindings above\n</script>\n`
        }
      }
    }

    const rxEventAttr =
      /(@[\w.-]+|v-on:[\w.-]+)=("([^"\n]*\n[^"]*)"|'([^'\n]*\n[^']*)')/g
    cleanContent = cleanContent.replace(
      rxEventAttr,
      (match, attr, doubleMatch, innerDouble, innerSingle) => {
        const quote = doubleMatch.startsWith('"') ? '"' : "'"
        const val = innerDouble !== undefined ? innerDouble : innerSingle
        if (!val.includes(';')) {
          return `${attr}=${quote}${val};${quote}`
        }
        return match
      },
    )

    const { descriptor } = await parseVue({
      content: cleanContent,
      filename: filePath,
    })
    const scopeId = `data-v-${id}`

    const parsed: ParsedCacheEntry = {
      lastMod,
      serverScript,
      cleanContent,
      scopeId,
      styles: descriptor.styles,
      hasCss: descriptor.styles.length > 0,
      meta,
      skeleton,
      layoutRoute: findLayoutRoute(filePath, meta),
    }
    parsedCache.set(id, parsed)
    return parsed
  }

  private static async buildScriptCode(
    id: string,
    routePath: string,
    isRootScript: boolean,
    parsed: ParsedCacheEntry,
    serverDataReplacement?: string,
  ) {
    const { cleanContent, scopeId } = parsed
    const compiled = await compileVueFile({
      content: cleanContent,
      filename: routePath,
      id: scopeId || id,
      isRootScript,
      layoutRoute: isRootScript ? parsed.layoutRoute : null,
    })

    if (compiled.errors.length) {
      // Thrown, not logged-and-served: a template Vue could not compile has
      // the raw unparseable expression in its render function, so serving it
      // is a browser-side SyntaxError behind a 200 and an empty page — the
      // report that surfaced this described exactly that. The throw lands in
      // the error registry as a 500 that names the file and the error.
      throw new Error(
        `Vue compile failed (${routePath}): ${compiled.errors.join('; ')}`,
      )
    }

    let code = compiled.code

    if (code.includes('.vue"') || code.includes(".vue'")) {
      code = rewriteVueImports(code)
    }

    if (serverDataReplacement !== undefined) {
      code = code.replace(RX_SERVER_DATA_TOKEN, () => serverDataReplacement)
    }

    if (!isRootScript) {
      for (const style of compiled.styles) {
        if (style.code) {
          code += `;\n(function(){var k='__vu_css_${id}';var s=document.getElementById(k)||(function(){var el=document.createElement('style');el.id=k;document.head.appendChild(el);return el})();s.textContent=${JSON.stringify(style.code)}})()`
        }
      }
    }

    const sourceURL =
      routePath.replace(/^.*[\\/]/, '').replace(/\?.*$/, '') ||
      (isRootScript ? 'root.vue' : 'module.vue')
    code += `\n//# sourceURL=${sourceURL}`

    return code
  }

  static async handleScript(
    id: string,
    routePath: string,
    isRootScript: boolean,
    parsed: ParsedCacheEntry,
    serverValues?: Record<string, any>,
  ) {
    const { lastMod, serverScript } = parsed
    const hasServerScript = Boolean(serverScript?.trim())

    // Static subcomponent (no server script) or root script: no per-request
    // data, so the built file can live on disk.
    if (!hasServerScript || isRootScript) {
      const dir = fs.resolve(cacheDir, 'js')
      // Root scripts carry the build variant in their name for the same reason
      // the chunk does (`vueChunkPath`): the cache is keyed on the *source's*
      // mtime, and flipping `build` in server.config.ts touches no source file
      // — measured serving a root compiled under 'runtime' after the flip to
      // 'full', missing the isCustomElement bridge the full build exists for.
      // Only roots: the variant changes nothing in a subcomponent's output.
      // The layout joins the name for the same reason the variant does: the
      // cache is keyed on the page's mtime, and creating, deleting or moving
      // a layout.vue touches no page file.
      const layoutTag = parsed.layoutRoute
        ? `.${toHash(parsed.layoutRoute)}`
        : ''
      const fileName = isRootScript
        ? `${id}.root.${vueBuildVariant()}${layoutTag}.js`
        : `${id}.js`
      const replacement =
        isRootScript && hasServerScript
          ? '(globalThis.__vue_server || {})'
          : undefined

      return await fs.getOrCreateCachedFile(dir, fileName, lastMod, () =>
        this.buildScriptCode(id, routePath, isRootScript, parsed, replacement),
      )
    }

    // Dynamic subcomponent with <script server>: compile once, then splice in
    // this request's data. The response is per-user, so it must not be stored.
    const cached = tokenizedModuleCache.get(id)
    let template = cached?.lastMod === lastMod ? cached.code : null

    if (template === null) {
      template = await this.buildScriptCode(id, routePath, false, parsed)
      tokenizedModuleCache.set(id, { lastMod, code: template })
    }

    const replacement = escapeScriptJson(serverValues || {})
    const code = template.replace(RX_SERVER_DATA_TOKEN, () => replacement)

    return response.type(code, 'text/javascript; charset=utf-8', {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }

  static async handleCss(id: string, parsed: ParsedCacheEntry) {
    const { lastMod, scopeId, styles } = parsed

    const dir = fs.resolve(cacheDir, 'css')
    const fileName = `${id}.css`

    return await fs.getOrCreateCachedFile(dir, fileName, lastMod, async () => {
      const compiled = await Promise.all(
        styles.map(style => compileStyleBlock({ style, id: scopeId || id })),
      )

      const css = compiled
        .map(s => s.code)
        .filter(Boolean)
        .join('\n\n')

      return css || null
    })
  }

  static async handleHtml(
    id: string,
    params: any,
    routePath: string,
    serverParams: any,
    parsed: ParsedCacheEntry,
    route?: { catchAll: boolean; base: string; param: string | null },
  ) {
    const { hasCss, serverScript } = parsed
    const hasServerData =
      Boolean(serverScript) || params?.errorCode !== undefined

    const payload =
      typeof serverParams === 'object' && serverParams
        ? { ...params, ...serverParams }
        : params?.errorCode !== undefined
          ? params
          : serverParams

    const serverDecl = hasServerData
      ? `<script>globalThis.__vue_server = ${escapeScriptJson(payload)};</script>`
      : ''

    // The route's shape, for `defineLayout()` (`client.ts`): the guard that
    // restricts it to catch-all pages reads `catchAll` from here, so the
    // stamp is the enforcement, not a convenience. Stamped on every page —
    // a non-catch-all page carries `catchAll: false`, which is what makes
    // the client-side error message possible instead of a bare undefined.
    const routeDecl = route
      ? `<script>globalThis.__vue_route = ${escapeScriptJson(route)};</script>`
      : ''

    let hydrated = VUE_HTML_SHELL.replace(
      '/*__SERVER_VARIABLES__*/',
      () => serverDecl + routeDecl,
    )

    // Static markup, injected verbatim — see parseSkeleton for why it is
    // never rendered. mount() replaces the container children, so it
    // disappears the moment the real component is up.
    if (parsed.skeleton) {
      hydrated = hydrated.replace(
        '<div id="app"></div>',
        () => `<div id="app">${parsed.skeleton}</div>`,
      )
    }

    if (parsed.meta.title) {
      const title = escapeHtml(parsed.meta.title)
      hydrated = hydrated.replace(
        '<title>Vue App</title>',
        () => `<title>${title}</title>`,
      )
    }

    // The layout's stylesheet loads before the page's, so a page can override
    // its layout the way source order normally implies.
    let layoutCss = ''
    if (parsed.layoutRoute) {
      const layoutFile = fs.resolve(Bakery.serveRoot, `.${parsed.layoutRoute}`)
      const layoutBun = Bun.file(layoutFile)
      if (fs.exists(layoutBun)) {
        const layoutId = toHash(hostKey(parsed.layoutRoute.slice(1)))
        const layoutParsed = await VueHandler.parseVueFile(
          layoutId,
          layoutBun,
          layoutFile,
          layoutBun.lastModified,
        )
        if (layoutParsed.hasCss) {
          layoutCss = `<link rel="stylesheet" id="__vu_css_${layoutId}" href="${parsed.layoutRoute}?__vue_css=true">\n`
        }
      }
    }

    const prio =
      layoutCss +
      (hasCss
        ? `<link rel="stylesheet" id="__vu_css_${id}" href="${routePath}?__vue_css=true">\n`
        : '') +
      `<script type="module" src="${routePath}?__vue_script=root"></script>`

    const htmlRes = await injectIfHtml(hydrated, params, { prio })
    return htmlRes || response.error('Failed to build HTML', 500)
  }
}

export class VueErrorHandler extends DynamicErrorHandler {
  static get config() {
    return {
      ext: ['vue'],
      dir: Bakery.serveRoot,
      include: ['**/error.vue', '**/error-*.vue'],
    }
  }

  static get cacheDir() {
    return cacheDir
  }

  static handle = sharedHandler
}

/** A server-script result that is already a complete response, not page data. */
function asDirectResponse(value: any) {
  if (value instanceof Response) return value
  if (value instanceof JsonResponseData) return value
  if (
    value &&
    typeof value === 'object' &&
    'arrayBuffer' in value &&
    'size' in value
  ) {
    return value as Bun.BunFile
  }
  return null
}

/**
 * Serve `value` if the server script already produced a complete response,
 * otherwise `null` so the caller treats it as page data.
 *
 * Both paths through `sharedHandler` — the `__vue_action` call and the ordinary
 * page render — need exactly this, and each carried its own verbatim copy. A
 * `BunFile` goes through `ETag.sendFile` so a conditional request can 304; the
 * `new Response` is the fallback for the un-cacheable case.
 */
async function serveIfDirect(value: any, req: Request) {
  const direct = asDirectResponse(value)
  if (!direct) return null
  if (direct instanceof Response || direct instanceof JsonResponseData) {
    return direct
  }
  return (await ETag.sendFile(direct, req)) || new Response(direct as any)
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: request handler — one branch per SFC render path
async function sharedHandler(
  this: typeof DynamicHandler | typeof DynamicErrorHandler,
  path: string,
  req: Request,
  errors?: Handler.Error.Data,
) {
  if (path.startsWith(VUE_CHUNK_PREFIX)) {
    return serveVueChunk(path, req)
  }

  path = normalizePath(path)
  const begun = await beginPageRoute(this, path, errors)
  if (begun instanceof Response) return begun
  const { errorData, info } = begun
  const routePath = `/${info.path}`

  const diskFile = info.file
  const lastMod = diskFile.lastModified
  const id = toHash(hostKey(info.path))

  const url = new URL(req.url)
  const vueScriptParam = url.searchParams.get('__vue_script')
  const isCss = url.searchParams.has('__vue_css')
  const accept = req.headers.get('accept') || ''
  const isScript =
    vueScriptParam !== null ||
    accept.includes('text/javascript') ||
    req.headers.get('sec-fetch-dest') === 'script'

  const parsed = await VueHandler.parseVueFile(
    id,
    diskFile,
    info.file.name!,
    lastMod,
  )

  // module-only: block page requests (allow script/css imports)
  if (parsed.meta.moduleOnly && !isScript && !isCss) {
    return response.error('Not Found', 404)
  }

  // A layout is scaffolding, not a destination: /admin/layout must not render
  // as a page. Script and css requests pass — they are how the root script of
  // every page under it imports the thing.
  if (routePath.endsWith('/layout.vue') && !isScript && !isCss) {
    return response.error('Not Found', 404)
  }

  // page-only: block module imports (allow root scripts, page, and css)
  if (parsed.meta.pageOnly && isScript && vueScriptParam === 'module') {
    return response.error('Not Found', 404)
  }

  const { serverScript } = parsed
  const params = info.getParams(path) || {}
  const finalParams = errorData ? Object.assign({}, params, errorData) : params

  const actionName =
    url.searchParams.get('__vue_action') || req.headers.get('x-vue-action')

  if (actionName) {
    const rejected = validateActionRequest(req, url)
    if (rejected) return rejected

    const actionFile = url.searchParams.get('__vue_file')

    let target = { id, lastMod, filePath: diskFile.name, script: serverScript }
    let targetMeta = parsed.meta

    if (actionFile) {
      const resolved = await resolveActionTarget(actionFile)
      if (!resolved) return response.error('Not Found', 404)

      const targetParsed = await VueHandler.parseVueFile(
        resolved.id,
        resolved.diskFile,
        resolved.filePath,
        resolved.lastMod,
      )
      target = {
        id: resolved.id,
        lastMod: resolved.lastMod,
        filePath: resolved.filePath,
        script: targetParsed.serverScript,
      }
      targetMeta = targetParsed.meta
    }

    // The gates above ran against the route. This one runs against whatever
    // `__vue_file` chose, which is the thing that is about to execute — and it
    // runs before the body is read, so a rejected request costs a parse it
    // never needed.
    const denied = validateActionTarget(
      { id: target.id, meta: targetMeta, serverScript: target.script },
      id,
      actionName,
    )
    if (denied) return denied

    const body = await this.params(req, finalParams)

    const actionArgs = Array.isArray(body?.args)
      ? body.args
      : Array.isArray(body)
        ? body
        : []

    const actionResult = await getServerResponse({
      script: target.script,
      id: target.id,
      lastMod: target.lastMod,
      req,
      body,
      filePath: target.filePath,
      actionName,
      actionArgs,
    })

    const direct = await serveIfDirect(actionResult, req)
    if (direct) return direct
    return response.json.success('OK', actionResult)
  }

  // Root scripts and stylesheets carry no per-request data — running the server
  // block for them would re-execute every top-level query on each sub-request.
  const needsServerData = !isCss && vueScriptParam !== 'root'

  if (!needsServerData) {
    if (isCss) return VueHandler.handleCss(id, parsed)
    return VueHandler.handleScript(id, routePath, true, parsed)
  }

  const body = await this.params(req, finalParams)
  const serverParams = await getServerResponse({
    script: serverScript,
    id,
    lastMod,
    req,
    body,
    filePath: diskFile.name,
  })

  const direct = await serveIfDirect(serverParams, req)
  if (direct) return direct

  if (isScript) {
    const serverValues = serverScript.trim() ? serverParams : undefined
    return VueHandler.handleScript(id, routePath, false, parsed, serverValues)
  }

  // `base` is the URL prefix the page owns: the file's directory. For
  // `wiki/[...page!].vue` that is `/wiki`; for a root-level catch-all it is
  // the empty string, which `defineLayout` treats as "everything".
  return VueHandler.handleHtml(
    id,
    finalParams,
    routePath,
    serverParams,
    parsed,
    {
      catchAll: Boolean(info.catchAll),
      base: routePath.slice(0, routePath.lastIndexOf('/')),
      param: info.params.length ? info.params[info.params.length - 1] : null,
    },
  )
}
