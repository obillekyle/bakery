import { LRUCache } from '../../cache/lru'
import { Bakery, hostStore } from '../../core/bakery'
import type { MapOf } from '../../types'
import { is } from '../common/misc'
import { Try } from '../common/try'
import { escapeScriptJson } from '../isomorphic/escape'
import { fs } from '../fs'

// Keyed by hostname, which comes from the Host header — bounded so a client
// cannot grow it without limit by varying that header per request.
const headBodyCache = new LRUCache<string, { head: string; body: string }>(64)

export function clearHeadBodyCache() {
  headBodyCache.clear()
}

export { headBodyCache }

type PackageJson = {
  name: string
  version: string
  main?: string
  module?: string
  browser?: string | MapOf<string>
  dependencies?: MapOf<string>
  devDependencies?: MapOf<string>
}

let depMap = ''

const hostDepMaps = new Map<string, string>()

export function initHostImportMaps() {
  hostDepMaps.clear()
  clearHeadBodyCache()
  const hosts = Bakery.config.hosts
  if (!hosts || !Object.keys(hosts).length) return

  const base = JSON.parse(depMap)
  const npmImports = base.imports || {}

  for (const [hostname, entry] of Object.entries(hosts)) {
    if (!entry.importMap) continue

    const imports: Record<string, string> = { ...npmImports }
    for (const [k, v] of Object.entries(entry.importMap)) {
      const cleanKey = k.replace(/\*$/, '')
      const cleanVal = String(v).replace(/\*$/, '')

      switch (cleanKey) {
        case '.server/client/utils':
        case './.server/client/utils':
        case '@client/utils':
          imports[cleanKey] = '/_client/utils.js'
          continue
      }

      imports[cleanKey] = cleanVal
        .replace(/^\.(?=\/)/, '')
        .replace(/^(?!(?:\/|https?:\/\/))/, '/')
    }

    hostDepMaps.set(hostname, JSON.stringify({ imports }))
  }
}

function resolveDepModule(pkgData: PackageJson, baseMod: string): string {
  if (is.string(pkgData.browser)) return pkgData.browser as string

  if (is.object(pkgData.browser)) {
    const cleanBase = baseMod.replace(/^\.\//, '')
    const browserField = pkgData.browser as MapOf<string>
    const lookupKeys = [baseMod, `./${cleanBase}`, cleanBase]
    const matchedOverride = lookupKeys.find(key => browserField[key])

    return matchedOverride ? browserField[matchedOverride] : baseMod
  }

  return baseMod
}

export async function initImportMap() {
  const pkgContent = await Try(() => Bun.file(fs.resolve(fs.cwd, 'package.json')).json())
  const pkg: any = pkgContent || {}
  const map = Bakery.config.importMap || {}
  const deps = pkg.dependencies || {}

  const resolvedMap: MapOf<string> = {}

  const imports = await Promise.all(
    Object.keys(deps).map(async dep => {
      const pkgData = await Try(
        Bun.file(`./node_modules/${dep}/package.json`).json(),
      )

      return { dep, pkgData: pkgData as PackageJson | null }
    }),
  )

  for (const { dep, pkgData } of imports) {
    if (!pkgData) continue

    const actualName = pkgData.name || dep
    resolvedMap[`${actualName}/`] = `/_nm/${actualName}/`

    const baseMod = pkgData.module || pkgData.main || 'index.js'
    const mod = resolveDepModule(pkgData, baseMod)

    const finalMod = typeof mod === 'string' ? mod : 'index.js'
    resolvedMap[actualName] =
      `/_nm/${actualName}/${finalMod.replace(/^\.\//, '')}`
  }

  for (const [k, v] of Object.entries(map)) {
    const cleanKey = k.replace(/\*$/, '')
    const cleanVal = String(v).replace(/\*$/, '')

    if (
      cleanVal === '.server/client/utils' ||
      cleanVal === './.server/client/utils' ||
      cleanKey === '@client/utils'
    ) {
      resolvedMap[cleanKey] = '/_client/utils.js'
      continue
    }

    resolvedMap[cleanKey] = cleanVal
      .replace(/^\.(?=\/)/, '')
      .replace(/^(?!(?:\/|https?:\/\/))/, '/')
  }

  depMap = JSON.stringify({ imports: resolvedMap })
}

export namespace DOMTools {
  export function importMap() {
    const hostname = hostStore.getStore()?.hostname
    const map = (hostname && hostDepMaps.get(hostname)) || depMap
    return `<script type="importmap">${map}</script>`
  }

  export function params(params: MapOf<string>) {
    const newParams: MapOf<string> = {}

    for (const [k, v] of Object.entries(params)) {
      if (k.startsWith('$$')) continue
      newParams[k] = v
    }

    // Was a hand-rolled `JSON.stringify(...).replace(/</g, ...)`, which is the
    // same job `escapeScriptJson` already does for every other inline-script
    // payload — its docstring even said "Mirrors utils/http/dom.ts". The two
    // had drifted: this copy never escaped U+2028/U+2029.
    return `<script>window.__PAGE_PARAMS__ = ${escapeScriptJson(newParams)}</script>`
  }

  type HTMLContent = {
    content: string
    responseInit: ResponseInit & { headers?: any }
  }

  const RX_IS_HTML = /<[a-z/][\s\S]*>/i
  const RX_IS_SVG_XML = /^\s*<(\?xml|svg|math)/i

  /** Content types `injectIfHtml` treats as an HTML document. */
  export function isHTMLContentType(contentType: string): boolean {
    return (
      contentType.startsWith('text/html') ||
      contentType.startsWith('application/xhtml+xml')
    )
  }

  /**
   * ResponseInit carrying `data`'s status and headers, minus Content-Length —
   * injection changes the body length, so a stale value must not survive into
   * the rebuilt Response. Shared by the buffered and streamed injection paths
   * so the two cannot drift on which headers survive.
   */
  export function htmlResponseInit(
    data: Response,
  ): ResponseInit & { headers: Headers } {
    const headers = new Headers(data.headers)
    headers.delete('content-length')
    return { status: data.status, statusText: data.statusText, headers }
  }

  async function checkBlobHtml(data: Blob): Promise<string> {
    const type = data.type || ''
    const isHtml = isHTMLContentType(type)

    return isHtml ? await data.text() : ''
  }

  async function checkResponseHtml(
    data: Response,
  ): Promise<{ html: string; init: ResponseInit }> {
    const contentType = data.headers.get('content-type') || ''

    if (!isHTMLContentType(contentType)) return { html: '', init: {} }

    return {
      html: await data.text(),
      init: htmlResponseInit(data),
    }
  }

  export async function isHTML(
    data: string | Response | Blob,
  ): Promise<HTMLContent> {
    if (is.string(data)) {
      const sample = (data as string).slice(0, 512)
      const isHtml = RX_IS_HTML.test(sample) && !RX_IS_SVG_XML.test(sample)
      return { content: isHtml ? (data as string) : '', responseInit: {} }
    }

    if (data instanceof Blob) {
      const html = await checkBlobHtml(data as Blob)
      return { content: html, responseInit: {} }
    }

    if (data instanceof Response) {
      const res = await checkResponseHtml(data as Response)
      return { content: res.html, responseInit: res.init }
    }

    return { content: '', responseInit: {} }
  }
}
