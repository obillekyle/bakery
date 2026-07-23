import { Bakery, hostStore } from '@server/core/bakery'
import { is } from '../common/misc'
import { Try } from '../common/try'
import { fs } from '../fs'

const headBodyCache = new Map<string, { head: string; body: string }>()

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

export function clearHostDepMaps() {
  hostDepMaps.clear()
}

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

    const json = JSON.stringify(newParams).replace(/</g, '\\u003c')
    return `<script>window.__PAGE_PARAMS__ = ${json}</script>`
  }

  type HTMLContent = {
    content: string
    responseInit: ResponseInit & { headers?: any }
  }

  const RX_IS_HTML = /<[a-z/][\s\S]*>/i
  const RX_IS_SVG_XML = /^\s*<(\?xml|svg|math)/i

  function isHTMLType(contentType: string): boolean {
    return (
      contentType.startsWith('text/html') ||
      contentType.startsWith('application/xhtml+xml')
    )
  }

  async function checkBlobHtml(data: Blob): Promise<string> {
    const type = data.type || ''
    const isHtml = isHTMLType(type)

    return isHtml ? await data.text() : ''
  }

  async function checkResponseHtml(
    data: Response,
  ): Promise<{ html: string; init: ResponseInit }> {
    const contentType = data.headers.get('content-type') || ''
    const isHtml = isHTMLType(contentType)

    if (!isHtml) return { html: '', init: {} }

    const headers = new Headers(data.headers)
    headers.delete('content-length')

    return {
      html: await data.text(),
      init: { status: data.status, statusText: data.statusText, headers },
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
