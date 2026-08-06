/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: '*/

/**
 * Browser runtime: binds the shared utilities onto `globalThis` and adds the
 * DOM-dependent pieces ($fmt, speculation rules, live navigation) on top.
 *
 * The utilities themselves live in `utils/isomorphic/` and are imported rather
 * than redefined here. This file used to carry its own copy of each one, which
 * is how the $fmt replacer-arity bug and the match() prototype-chain bug each
 * had to be fixed twice.
 */
import type { MapOf } from '../types'
import { Case } from '../utils/isomorphic/case'
import { escapeHtml as escapeHTML } from '../utils/isomorphic/escape'
import { is } from '../utils/isomorphic/is'
import { match, matchDefault } from '../utils/isomorphic/match'
import { Math2 } from '../utils/isomorphic/math'
import { any, assert, repeat, throws } from '../utils/isomorphic/misc'
import { circularReplacer } from '../utils/isomorphic/stringify'
import { Try, tryCatch } from '../utils/isomorphic/try'

export { escapeHTML }

function processGetBody(
  body: FormData | MapOf<any> | URLSearchParams | string,
) {
  if (body instanceof URLSearchParams) {
    return body.toString()
  }

  if (body instanceof FormData || (is.object(body) && body !== null)) {
    const urlSearchParams = new URLSearchParams()
    const entries =
      body instanceof FormData ? body.entries() : Object.entries(body)

    for (const [key, value] of entries) {
      urlSearchParams.append(key, (value as any).toString())
    }
    return urlSearchParams.toString()
  }

  return String(body)
}

function randomId(length = 8) {
  const arr = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(arr)
  return Array.from(arr, dec => dec.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length)
}

type RequestJson = RequestInit & { body?: any }

async function request(
  url: string,
  init: RequestJson | string = {},
  bodyData?: any,
): Promise<JsonResponse> {
  let options: RequestJson = {}
  if (typeof init === 'string') {
    options = { method: init, body: bodyData }
  } else {
    options = init || {}
  }

  const method = (options.method || 'GET').toUpperCase()
  const body = options.body || {}

  if (method === 'GET' && body && Object.keys(body).length > 0) {
    const query = processGetBody(body)
    if (query) {
      url = `${url}${url.includes('?') ? '&' : '?'}${query}`
    }
  }

  const isFormData = body instanceof FormData

  const response = await fetch(url, {
    ...options,
    method,
    body:
      method === 'GET'
        ? undefined
        : isFormData
          ? body
          : JSON.stringify(body),
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  })

  const [err, data] = await tryCatch(response.json.bind(response))

  if (err) {
    throws(`Request failed: ${err.message || 'Unknown error'}`)
  }

  if (
    data &&
    typeof data === 'object' &&
    'status' in data &&
    'message' in data
  ) {
    const status = (data as any).status
    if (status >= 200 && status < 300) {
      return data as JsonResponse
    }
    throws((data as any).message)
  }

  return data
}

export function formatHTML(html: string, indentWidth: number = 2): string {
  if (!html) return ''

  const cleanHtml = html
    .replace(/\n/g, '')
    .replace(/[\s]{2,}/g, ' ')
    .replace(/>\s*</g, '><')
    .trim()

  const tokens = cleanHtml.match(/<[^>]+>|[^<]+/g) || []
  let indentLevel = 0

  return tokens.reduce((formattedString, token) => {
    const isClosing = /^<\//.test(token)
    const isSelfClosing =
      /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)[^>]*>/i.test(
        token,
      ) || /<[^>]+\/>/.test(token)
    const isOpening = /^<[^/!?]/.test(token) && !isSelfClosing

    indentLevel = isClosing ? Math.max(0, indentLevel - 1) : indentLevel

    const indent = ' '.repeat(indentLevel * indentWidth)
    const appendedToken =
      formattedString === '' ? token : `\n${indent}${token.trim()}`

    indentLevel = isOpening ? indentLevel + 1 : indentLevel

    return formattedString + appendedToken
  }, '')
}

Object.assign(globalThis, {
  match,
  matchDefault,
  Try,
  tryCatch,
  is,
  Case,
  Math2,
  throws,
  assert,
  any,
  escapeHTML,
  repeat,
  request,
  randomId,
  Bakery: {
    version: import.meta.env.BAKERY_VERSION,
    async virtual(path: string) {
      const response = await fetch(path)
      if (!response.ok) {
        return null
      }

      const contentType = response.headers.get('Content-Type') || ''
      if (contentType.includes('application/json')) {
        return response.json()
      } else {
        const text = await response.text()

        if (path.endsWith('.css')) {
          const style = document.createElement('style')
          style.textContent = text
          document.head.appendChild(style)
          return null
        }

        // The body was already consumed above; re-reading it throws.
        return text
      }
    },

    params<T = MapOf<any>>(): T {
      return any(window).__PAGE_PARAMS__ as T
    },
  },
  $fmt(data: any): string {
    if (data == null) return ''
    if (is.string(data)) return data
    if (is.bigint(data)) return `${data}n`
    if (is.symbol(data)) return data.toString()

    if (data instanceof Element) return `\n${formatHTML(data.outerHTML)}`
    if (data instanceof Error) return data.stack || data.message || String(data)
    if (data instanceof Date) return data.toISOString()
    if (data instanceof RegExp) return data.toString()

    if (is.function(data)) {
      return data.name ? `[Function: ${data.name}]` : '[Function]'
    }

    if (data instanceof Set) {
      const fmt = (globalThis as any).$fmt
      return `Set(${data.size}) { ${Array.from(data)
        .map(v => fmt(v))
        .join(', ')} }`
    }
    if (data instanceof Map) {
      const fmt = (globalThis as any).$fmt
      return `Map(${data.size}) { ${Array.from(data.entries())
        .map(([k, v]) => `${fmt(k)} => ${fmt(v)}`)
        .join(', ')} }`
    }

    if (
      Array.isArray(data) ||
      typeof data?.toJSON === 'function' ||
      (typeof data === 'object' &&
        Object.prototype.toString.call(data) === '[object Object]')
    ) {
      try {
        // Cycle handling comes from circularReplacer; this adds only the
        // display rules for values JSON has no representation for.
        return JSON.stringify(
          data,
          circularReplacer((_key, value) => {
            if (is.bigint(value)) return `${value}n`
            if (is.function(value))
              return value.name ? `[Function: ${value.name}]` : '[Function]'
            if (value instanceof RegExp) return String(value)
            return value
          }),
          2,
        )
      } catch {
        return String(data)
      }
    }

    return String(data)
  },
})

if (typeof document !== 'undefined') {
  let debounceTimer: any

  const updateSpeculationRules = () => {
    const urls = new Set<string>()
    const elements = document.querySelectorAll(
      '[href]:not(link, base, use, image)',
    )

    const ignorePattern = /([?&](utm_|fbclid)|\.(pdf|zip)$)/i
    for (const el of elements) {
      const prefetchAttr = el.getAttribute('prefetch')
      if (prefetchAttr === 'false') continue

      const url = el.getAttribute('href')?.trim()

      if (
        !url ||
        url.startsWith('#') ||
        url.includes(':') ||
        ignorePattern.test(url) ||
        url.toLowerCase().includes('logout')
      )
        continue

      urls.add(url)
    }

    if (urls.size === 0) return

    document.querySelector('script[type="speculationrules"]')?.remove()

    const specScript = document.createElement('script')
    specScript.type = 'speculationrules'

    // Prerender the same filtered list as prefetch, not every link on the page.
    // A `source: 'document'` rule with href_matches '/*' and eager eagerness
    // ignored the exclusions above and fully loaded — and ran the JS of — every
    // same-origin link, including things like /logout or a destructive GET.
    const urlList = Array.from(urls)
    specScript.textContent = JSON.stringify({
      prefetch: [{ source: 'list', urls: urlList }],
      prerender: [{ source: 'list', urls: urlList, eagerness: 'moderate' }],
    })

    document.head.appendChild(specScript)
  }

  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(updateSpeculationRules, 1000)
  })

  const initObserver = () => {
    updateSpeculationRules()
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initObserver)
  } else {
    initObserver()
  }
}
