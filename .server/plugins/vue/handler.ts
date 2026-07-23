import { Bakery, hostKey } from '@server/core/bakery'
import type { Handler } from '@server/handlers/core/$base'
import { DynamicHandler } from '@server/handlers/core/$dynamic'
import { DynamicErrorHandler } from '@server/handlers/core/$error'
import { Logger } from '@server/logger'
import { fs, response, toHash } from '@server/utils'
import { ETag, injectIfHtml } from '@server/utils/http'

const logger = new Logger('vue')

import { compileStyleBlock, compileVueFile, parseVue } from './compile'
import { VUE_HTML_SHELL } from './shell'
import type { ParsedCacheEntry } from './types'
import {
  cacheDir,
  getServerResponse,
  parsedCache,
  RX_SERVER_SCRIPT,
  VUE_VERSION,
} from './utils'

function normalizePath(path: string) {
  return path.endsWith('.js') ? path.slice(0, -3) : path
}

const VUE_CHUNK_PREFIX = '/_vue/'

const BUNDLE_DEFINES = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

async function serveVueChunk(path: string, req: Request): Promise<Response> {
  if (path === `/_vue/${VUE_VERSION}.js`) {
    const dir = fs.resolve(Bakery.cacheDir, 'vue-official', 'chunks')
    const fileName = `${VUE_VERSION}.js`

    let sourcePath = ''
    try {
      sourcePath = Bun.resolveSync('vue/dist/vue.esm-bundler.js', Bakery.root)
    } catch {
      return response.error('Vue not found', 404)
    }
    const sourceMtime = Bun.file(sourcePath).lastModified

    const file = await fs.getOrCreateCachedFile(
      dir,
      fileName,
      sourceMtime,
      async () => {
        const result = await Bun.build({
          entrypoints: [sourcePath],
          target: 'browser',
          format: 'esm',
          minify: import.meta.env.PROD,
          define: BUNDLE_DEFINES,
        })

        if (!result.success) {
          logger.log(
            `Build failed: ${result.logs.map(l => l.message).join('; ')}`,
            'error',
          )
          return null
        }
        return result.outputs[0].arrayBuffer()
      },
    )

    if (file) {
      const res = await ETag.sendFile(file, req)
      res.headers.set('Cache-Control', 'public, max-age=31536000, immutable')
      return res
    }
    return response.error('Vue chunk not built', 500)
  }
  return response.error('Not Found', 404)
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

  static async parseVueFile(
    id: string,
    diskFile: Bun.BunFile,
    filePath: string,
    lastMod: number,
  ) {
    const cached = parsedCache.get(id)
    if (cached && cached.lastMod === lastMod) return cached

    const raw = await diskFile.text()
    const serverMatch = raw.match(RX_SERVER_SCRIPT)
    const serverScript = serverMatch?.[1] || ''
    let cleanContent = raw.replace(RX_SERVER_SCRIPT, '')

    // Fix Vue compiler bug for multiline inline event handlers without semicolons
    const rxEventAttr =
      /(@[\w.-]+|v-on:[\w.-]+)=("([^"]*\n[^"]*)"|'([^']*\n[^']*)')/g
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

    const parsed = {
      lastMod,
      serverScript,
      cleanContent,
      scopeId,
      cssVars: descriptor.cssVars || [],
      hasCss: descriptor.styles.length > 0,
    }
    parsedCache.set(id, parsed)
    return parsed
  }

  static async handleScript(
    id: string,
    routePath: string,
    isRootScript: boolean,
    parsed: ParsedCacheEntry,
  ) {
    const { lastMod, cleanContent, scopeId } = parsed

    const dir = fs.resolve(cacheDir, 'js')
    const fileName = `${id}${isRootScript ? '.root' : ''}.js`

    return await fs.getOrCreateCachedFile(dir, fileName, lastMod, async () => {
      const compiled = await compileVueFile({
        content: cleanContent,
        filename: routePath,
        id: scopeId || id,
        isRootScript,
      })

      if (compiled.errors.length) {
        logger.log(`Compile errors: ${compiled.errors.join(', ')}`, 'error')
      }

      let code = compiled.code

      if (!isRootScript) {
        for (const style of compiled.styles) {
          if (style.code) {
            code += `;\n(function(){var k='__vu_css_${id}';if(!document.getElementById(k)){var s=document.createElement('style');s.id=k;s.textContent=${JSON.stringify(style.code)};document.head.appendChild(s)}})()`
          }
        }
      }

      const sourceURL =
        routePath.replace(/^.*[\\/]/, '').replace(/\?.*$/, '') ||
        (isRootScript ? 'root.vue' : 'module.vue')
      code += `\n//# sourceURL=${sourceURL}`

      return code
    })
  }

  static async handleCss(id: string, parsed: ParsedCacheEntry) {
    const { lastMod, cleanContent, scopeId } = parsed

    const dir = fs.resolve(cacheDir, 'css')
    const fileName = `${id}.css`

    return await fs.getOrCreateCachedFile(dir, fileName, lastMod, async () => {
      const { descriptor } = await parseVue({
        content: cleanContent,
        filename: `/${id}.vue`,
      })
      const styles = await Promise.all(
        descriptor.styles.map(style =>
          compileStyleBlock({ style, id: scopeId || id }),
        ),
      )

      const css = styles
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
  ) {
    const { hasCss, serverScript } = parsed
    const serverDecl =
      serverScript || params?.errorCode !== undefined
        ? `<script>globalThis.__vue_server = ${JSON.stringify(
            typeof serverParams === 'object' && serverParams
              ? { ...params, ...serverParams }
              : params?.errorCode !== undefined
                ? params
                : serverParams,
          )};</script>`
        : ''
    const hydrated = VUE_HTML_SHELL.replace(
      '/*__SERVER_VARIABLES__*/',
      serverDecl,
    )

    const finalParams = {
      ...params,
      $$prio:
        (hasCss
          ? `<link rel="stylesheet" id="__vu_css_${id}" href="${routePath}?__vue_css=true">\n`
          : '') +
        `<script type="module" src="${routePath}?__vue_script=root"></script>`,
    }

    const htmlRes = await injectIfHtml(hydrated, finalParams)
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
  const errorData = errors || (this as any).DEFAULT_ERROR
  const info = await this.resolveRoute(path, errorData)
  if (!info) return response.error('Not Found')
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
  const { serverScript } = parsed
  const params = info.getParams(path) || {}
  const finalParams = errorData ? Object.assign({}, params, errorData) : params
  const body = await this.params(req, finalParams)
  const serverParams = await getServerResponse({
    script: serverScript,
    id,
    lastMod,
    req,
    body,
  })

  if (isScript) {
    return VueHandler.handleScript(
      id,
      routePath,
      vueScriptParam === 'root',
      parsed,
    )
  }

  if (isCss) {
    return VueHandler.handleCss(id, parsed)
  }

  return VueHandler.handleHtml(id, finalParams, routePath, serverParams, parsed)
}
