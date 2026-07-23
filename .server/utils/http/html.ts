import { Bakery, hostStore } from '@server/core/bakery'
import { DOMTools, headBodyCache } from './dom'
import { ETag } from './etag'

function injectBrand(res: Response) {
  return Object.defineProperty(res, '__injected__', {
    value: true,
    enumerable: false,
  })
}

function isInjected(res: Response) {
  return (res as any).__injected__
}

export async function injectIfHtml(
  data: string | Response | Blob,
  params?: MapOf<string>,
): Promise<Response | null> {
  if (data instanceof Response && isInjected(data)) return data

  const { content, responseInit } = await DOMTools.isHTML(data)
  if (!content) return null

  const headers = new Headers(responseInit?.headers)
  const html = assembleHtml(content, params)

  headers.set('Content-Type', 'text/html; charset=utf-8')
  headers.set('ETag', ETag.fromText(html))

  const response = new Response(html, {
    ...responseInit,
    headers,
  })

  return injectBrand(response)
}

const RX_CURLY_PARAMS = /{{\s*([^,\s}]+)(?:\s*,\s*([^}]+))?\s*}}/g
const RX_GFONTS = /https?:\/\/fonts\.(?:googleapis|google)\.com\/css2/g
const RX_HEAD_TAG = /<head[^>]*>/i
const RX_BODY_END = /<\/body>/i

function getConfigInjects() {
  const host = hostStore.getStore()?.hostname || '__default__'
  const cached = headBodyCache.get(host)
  if (cached) return cached

  const scripts: string[] = [
    DOMTools.importMap(),
    '<script src="/_client/utils.js" type="module"></script>',
    '<!--prio-->',
  ]

  if (import.meta.env.DEV) {
    scripts.push('<script src="/_client/livereload.js" type="module"></script>')
  }

  const head = scripts.join('') + (Bakery.config.head || '')
  const body = Bakery.config.body || ''

  const result = { head, body }
  headBodyCache.set(host, result)
  return result
}

export function assembleHtml(content: string, params: MapOf<string> = {}) {
  const configInjects = getConfigInjects()
  const paramsStr = DOMTools.params(params)

  const headInjects = configInjects.head + paramsStr + (params.$$head || '')
  const bodyInjects = configInjects.body + (params.$$body || '')

  const headInj2 = headInjects.replace('<!--prio-->', params.$$prio || '')

  let html = content

  html = RX_HEAD_TAG.test(html)
    ? html.replace(RX_HEAD_TAG, `$&${headInj2}`)
    : headInj2 + html

  html = RX_BODY_END.test(html)
    ? html.replace(RX_BODY_END, `${bodyInjects}$&`)
    : html + bodyInjects

  html = html.replace(RX_GFONTS, '/_gf/')

  const hasParams = Object.keys(params).length > 0
  if (hasParams) {
    html = html.replace(RX_CURLY_PARAMS, (_, key, fallback) => {
      const val = params?.[key] ?? fallback?.trim()
      return val !== undefined ? Bun.escapeHTML(String(val)) : `{{${key}}}`
    })
  }

  return html
}
