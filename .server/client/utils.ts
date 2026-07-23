/** biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: '*/
const matchDefault = Symbol('matchDefault')

function matchStringCase(value: string, cases: any) {
  if (value in cases) {
    const result = cases[value]
    return is.function(result) ? result(value) : result
  }
  if (matchDefault in cases) {
    const result = cases[matchDefault]
    return is.function(result) ? result(value) : result
  }
  return undefined
}

function matchArrayCases(value: any, cases: any[]) {
  for (const [predicate, result] of cases) {
    if (
      predicate === match ||
      predicate === matchDefault ||
      predicate === value ||
      (is.function(predicate) && Boolean(predicate(value)))
    ) {
      return is.function(result) ? result(value) : result
    }
  }
  return undefined
}

const match = (value: any, cases: any) => {
  if (is.string(value) && !Array.isArray(cases)) {
    return matchStringCase(value, cases)
  }
  if (Array.isArray(cases)) {
    return matchArrayCases(value, cases)
  }
  return undefined
}

match.default = matchDefault
;(match as any)[Symbol.toPrimitive] = () => matchDefault

function tryThrow<T>(
  callback: () => Promise<T> | T,
  error?: string | Error,
): Promise<T> {
  return Promise.try(callback).catch((err: any) => {
    throw typeof error === 'string' ? new Error(error) : error || err
  })
}

function tryReturn<T, D>(
  value: Wrapped<T>,
  defaultValue: Wrapped<D, [Error]>,
): T | D {
  try {
    const unwrapped = is.function(value) ? (value as any)() : value
    if (
      unwrapped instanceof Promise ||
      (unwrapped !== null &&
        typeof unwrapped === 'object' &&
        typeof (unwrapped as any).catch === 'function')
    ) {
      return (unwrapped as any).catch((error: any) =>
        is.function(defaultValue)
          ? (defaultValue as any)(error)
          : defaultValue,
      ) as T
    }
    return unwrapped as T
  } catch (error: any) {
    const unwrappedDefault = is.function(defaultValue)
      ? (defaultValue as any)(error)
      : defaultValue
    return unwrappedDefault as D
  }
}

function trySilent<T>(value: Wrapped<T>): T | null {
  return tryReturn(value, null as any)
}

type TryType = {
  <T>(value: Wrapped<T>): T | null
  catch<T>(
    promise: Wrapped<Promise<T> | T>,
  ): Promise<[Error, null] | [null, T]> | ([Error, null] | [null, T])
  return<T, D>(value: Wrapped<T>, defaultValue: Wrapped<D, [Error]>): T | D
  throw: typeof tryThrow
  silent<T>(value: Wrapped<T>): T | null
}

const Try: TryType = Object.assign(
  function Try<T>(value: Wrapped<T>): T | null {
    return trySilent(value)
  },
  {
    catch<T>(
      promise: Wrapped<Promise<T> | T>,
    ): Promise<[Error, null] | [null, T]> | ([Error, null] | [null, T]) {
      if (typeof promise === 'function') {
        return Promise.try(promise as any)
          .then(data => [null, data] as [null, T])
          .catch(error => [error, null] as [Error, null])
      }
      if (promise instanceof Promise) {
        return promise
          .then(data => [null, data] as [null, T])
          .catch(error => [error, null] as [Error, null])
      }
      return [null, promise] as [null, T]
    },

    return: tryReturn,

    throw: tryThrow,

    silent: trySilent,
  },
)

const tryCatch = Try.catch

const assert = (condition: any, message?: string): asserts condition => {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}
const any = <T = any>(v: any): T => v
const repeat = (n: number, fn?: (i: number) => any): any[] =>
  Array.from({ length: n }, (_, k) => (fn ? fn(k) : k))

const is: ISFunction = Object.assign(
  function is(value: any, type?: string) {
    switch (type) {
      case 'array':
        return Array.isArray(value)
      case 'null':
        return value === null
      case 'undefined':
        return value === undefined
      default:
        return typeof value === type
    }
  },
  {
    array: Array.isArray,
    null: (v: any) => v === null,
    undefined: (v: any) => v === undefined,
    string: (v: any) => typeof v === 'string',
    number: (v: any) => typeof v === 'number',
    boolean: (v: any) => typeof v === 'boolean',
    bigint: (v: any) => typeof v === 'bigint',
    symbol: (v: any) => typeof v === 'symbol',
    object: (v: any) =>
      typeof v === 'object' && v !== null && !Array.isArray(v),
    function: (v: any) => typeof v === 'function',
  },
) as ISFunction

function kebab(s: string) {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

function camel(s: string) {
  return s
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[A-Z]/, m => m.toLowerCase())
}

function pascal(s: string) {
  const c = camel(s)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

function snake(s: string) {
  return s
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
}

const Case = Object.assign(
  function Case(
    type: 'kebab' | 'camel' | 'pascal' | 'snake',
    str: string,
  ): string {
    switch (type) {
      case 'kebab':
        return kebab(str)
      case 'camel':
        return camel(str)
      case 'pascal':
        return pascal(str)
      case 'snake':
        return snake(str)
      default:
        return str
    }
  },
  {
    kebab,
    camel,
    pascal,
    snake,
    upper: (str: string) => str.toUpperCase(),
    lower: (str: string) => str.toLowerCase(),
    caps: (str: string) => str.toUpperCase().replace(/[\s_-]+/g, ''),
  },
)

const Math2 = {
  clamp(value: number, min?: number, max?: number): number {
    const minVal = min ?? -Infinity
    const maxVal = max ?? Infinity
    return Math.min(Math.max(value, minVal), maxVal)
  },

  step(value: number, step: number): number {
    return Math.round(value / step) * step
  },
}

const throws = (message: string | Error): never => {
  throw typeof message === 'string' ? new Error(message) : message
}

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
  init: RequestJson = {},
): Promise<JsonResponse> {
  const method = (init.method || 'GET').toUpperCase()
  const body = init.body || {}

  if (method === 'GET') {
    const query = processGetBody(body)
    if (query) {
      url = `${url}?${query}`
    }
  }

  const response = await fetch(url, {
    ...init,
    method,
    body: method === 'GET' ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
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

const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHTML(str: any): string {
  if (str === null || str === undefined) return ''
  return String(str).replace(/[&<>"']/g, match => escapeMap[match] || match)
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

        return response.text()
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
        const cache = new Set()
        return JSON.stringify(
          data,
          (value: any) => {
            if (is.object(value) && value !== null) {
              if (cache.has(value)) return '[Circular]'
              cache.add(value)
            }
            if (is.bigint(value)) return `${value}n`
            if (is.function(value))
              return value.name ? `[Function: ${value.name}]` : '[Function]'
            if (value instanceof RegExp) return String(value)
            return value
          },
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

    specScript.textContent = JSON.stringify({
      prefetch: [{ source: 'list', urls: Array.from(urls) }],
      prerender: [
        {
          source: 'document',
          where: { href_matches: '/*' },
          eagerness: 'eager',
        },
      ],
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
