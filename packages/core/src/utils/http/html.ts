import { Bakery, hostStore } from '../../core/bakery'
import type { MapOf } from '../../types'
import { Try } from '../common/try'
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

/**
 * Rebuild `res` with `status`, carrying the injection brand across.
 *
 * `Response.status` is read-only, so changing it means constructing a new
 * Response — and a plain rebuild silently drops the `__injected__` marker,
 * which is the only thing stopping `processResponse` running the page through
 * `injectIfHtml` a second time and emitting two import maps and two copies of
 * the client bundle. That is why this lives next to the brand rather than at
 * the call site.
 */
export function withStatus(res: Response, status: number): Response {
  if (res.status === status) return res

  const next = new Response(res.body, {
    status,
    statusText: res.statusText,
    headers: res.headers,
  })

  return isInjected(res) ? injectBrand(next) : next
}

/**
 * Server-controlled markup injected into the document. Deliberately a separate
 * argument from `params`: `params` is request-derived (for GET it is the query
 * string), so `$$head`-style keys arriving from a client must never be honoured.
 */
export interface HtmlInjects {
  head?: string
  body?: string
  prio?: string
}

/**
 * Bodies at or below this many bytes take the buffered path; above it (or when
 * the size cannot be known without buffering) they stream. It doubles as the
 * probe window: if no `<head…>` tag has appeared within this many bytes, the
 * streamed path gives up and buffers (see `probeAndInject`).
 *
 * Decision matrix (`injectIfHtml`):
 * - string input                      → buffered (already fully in memory)
 * - {{…}} params substitution needed  → buffered, whatever the size (the
 *                                       substitution is a whole-document pass)
 * - Blob,     size ≤ threshold        → buffered
 * - Blob,     size > threshold        → streamed
 * - Response, Content-Length ≤ thr.   → buffered
 * - Response, Content-Length > thr.   → streamed
 * - Response, size unknown            → probe: read up to the threshold; EOF
 *                                       first means a small body → buffered
 *                                       (the status quo), otherwise → streamed
 *                                       (the case where buffering hurts most)
 * - streaming chosen, but no `<head…>` match within the probe window
 *                                     → buffered fallback: the no-head case
 *                                       prepends the head fragment *before*
 *                                       content that streaming would already
 *                                       have sent
 *
 * Buffered responses carry a strong content ETag for the 304 machinery.
 * Streamed responses carry none — see `streamedResponse` for why that is not
 * faked.
 */
export const STREAM_THRESHOLD_BYTES = 64 * 1024

export async function injectIfHtml(
  data: string | Response | Blob,
  params?: MapOf<string>,
  injects?: HtmlInjects,
): Promise<Response | null> {
  if (data instanceof Response && isInjected(data)) return data

  // {{param}} substitution (and only that — the __PAGE_PARAMS__ script is a
  // head fragment either way) needs the whole document in one string, so a
  // params-bearing call takes the buffered path regardless of size.
  const hasParams = !!params && Object.keys(params).length > 0

  if (!hasParams && data instanceof Response && data.body) {
    const contentType = data.headers.get('content-type') || ''
    if (!DOMTools.isHTMLContentType(contentType)) return null

    const declaredRaw = data.headers.get('content-length')
    const declared = declaredRaw ? Number(declaredRaw) : NaN
    const size =
      Number.isFinite(declared) && declared >= 0 ? declared : undefined

    if (size === undefined || size > STREAM_THRESHOLD_BYTES) {
      return probeAndInject(
        data.body,
        size !== undefined,
        DOMTools.htmlResponseInit(data),
        injects,
      )
    }
  }

  if (!hasParams && data instanceof Blob) {
    if (!DOMTools.isHTMLContentType(data.type || '')) return null

    if (data.size > STREAM_THRESHOLD_BYTES) {
      return probeAndInject(data.stream(), true, {}, injects)
    }
  }

  const { content, responseInit } = await DOMTools.isHTML(data)
  if (!content) return null

  return bufferedResponse(content, params, injects, responseInit)
}

/** The one writer of the buffered injection Response — main path and the
 * streamed path's fallback both come through here. */
function bufferedResponse(
  content: string,
  params: MapOf<string> | undefined,
  injects: HtmlInjects | undefined,
  responseInit: ResponseInit & { headers?: any },
): Response {
  const headers = new Headers(responseInit?.headers)
  const html = assembleHtml(content, params, injects)

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

const GFONTS_REWRITE = '/_gf/'

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

/**
 * The final head/body fragments for one document: config injects + the
 * __PAGE_PARAMS__ script + per-call injects, with `<!--prio-->` resolved.
 * Computed once per response, up front — the streamed path must not defer this
 * into a pull callback, where the AsyncLocalStorage host context that
 * `getConfigInjects` and `DOMTools.importMap` read may no longer be live.
 */
function computeInjects(params: MapOf<string>, injects: HtmlInjects) {
  const configInjects = getConfigInjects()
  const paramsStr = DOMTools.params(params)

  const headInjects = configInjects.head + paramsStr + (injects.head || '')
  const bodyInjects = configInjects.body + (injects.body || '')

  // Function replacers throughout this file: the injected strings can contain
  // data derived from a request, and `$&` / `$'` / `` $` `` in a replacement
  // *string* would splice surrounding document content into the output.
  const head = headInjects.replace('<!--prio-->', () => injects.prio || '')

  return { head, body: bodyInjects }
}

/** Insert `head` after the first `<head…>` tag, or prepend it when the
 * document has none. Single writer for both the buffered path and the
 * streamed path's probe. */
function spliceHead(html: string, head: string): string {
  return RX_HEAD_TAG.test(html)
    ? html.replace(RX_HEAD_TAG, match => `${match}${head}`)
    : head + html
}

/** Insert `body` before the first `</body>`, or append it at the very end
 * when the document has none. */
function spliceBodyEnd(html: string, body: string): string {
  // `test()` then `replace()` scans the document twice, and `</body>` is at the
  // very end, so the discarded `test()` pass is a full scan of the page. One
  // `replace()` with a flag set from the replacer does the same job in one.
  // (The `<head>` case above is left as-is: the tag is near the start, so its
  // `test()` exits early and the same rewrite measured no faster.)
  let matched = false
  const out = html.replace(RX_BODY_END, match => {
    matched = true
    return `${body}${match}`
  })
  return matched ? out : out + body
}

/** Rewrite Google Fonts css2 URLs to the local `/_gf/` proxy. Single writer:
 * the buffered path runs it over the whole document, the streamed path over
 * each window and the final carry. */
function rewriteFontsUrls(html: string): string {
  // Both alternatives in RX_GFONTS require the literal `fonts.goog`, so this
  // substring check cannot skip a document the regex would have matched — and
  // most documents have no Google Fonts link at all.
  if (!html.includes('fonts.goog')) return html
  return html.replace(RX_GFONTS, () => GFONTS_REWRITE)
}

export function assembleHtml(
  content: string,
  params: MapOf<string> = {},
  injects: HtmlInjects = {},
) {
  const frags = computeInjects(params, injects)

  let html = spliceHead(content, frags.head)
  html = spliceBodyEnd(html, frags.body)
  html = rewriteFontsUrls(html)

  const hasParams = Object.keys(params).length > 0
  if (hasParams) {
    html = html.replace(RX_CURLY_PARAMS, (_, key, fallback) => {
      const val = params?.[key] ?? fallback?.trim()
      return val !== undefined ? Bun.escapeHTML(String(val)) : `{{${key}}}`
    })
  }

  return html
}

// ---------------------------------------------------------------------------
// Streamed injection
//
// The exact same three rewrites as `assembleHtml`, in the same order, without
// holding the document in memory. The head splice happens on a bounded probe
// (the tag is near the start of any real document) using the same
// `spliceHead`; the body-end insert and the fonts rewrite — the two passes
// that force a scan to the end of the document — run as chunk-boundary-safe
// text stages over the same regexes. Content inserted by the body stage flows
// through the fonts stage but not back through the body stage, which is
// exactly the buffered path's head → body → fonts ordering.
// ---------------------------------------------------------------------------

/** `'</body>'.length - 1`: the longest proper prefix of the body-end pattern
 * that can be left dangling at a chunk boundary. */
const BODY_END_HOLDBACK = '</body>'.length - 1

/** Longest text RX_GFONTS can match, minus one — any incomplete match prefix
 * at a window edge is at most this long, so holding back this many characters
 * guarantees no match is ever split across two windows. */
const FONTS_HOLDBACK = 'https://fonts.googleapis.com/css2'.length - 1

/**
 * Read the response body until either EOF or enough bytes to commit to
 * streaming. Streaming needs two things the probe establishes: proof the body
 * is actually large (unless Content-Length already said so), and a `<head…>`
 * match — the no-head fallback prepends to the very start of the document,
 * which a stream that has begun emitting can no longer do. Anything that fails
 * those checks is drained and handed to the buffered path, whose output is the
 * long-standing behavior.
 */
async function probeAndInject(
  source: ReadableStream<Uint8Array>,
  knownLarge: boolean,
  responseInit: ResponseInit & { headers?: any },
  injects?: HtmlInjects,
): Promise<Response | null> {
  const reader = source.getReader()
  const decoder = new TextDecoder()

  let text = ''
  let bytes = 0
  let head: RegExpExecArray | null = null
  let eof = false
  let commit = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      eof = true
      text += decoder.decode()
      break
    }

    bytes += value.length
    text += decoder.decode(value, { stream: true })

    if (!head) head = RX_HEAD_TAG.exec(text)

    if (head && (knownLarge || bytes > STREAM_THRESHOLD_BYTES)) {
      commit = true
      break
    }

    // Head tag not within the probe window: stop growing the probe and fall
    // back to buffering the rest.
    if (!head && bytes > STREAM_THRESHOLD_BYTES) break
  }

  if (!commit) {
    if (!eof) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          text += decoder.decode()
          break
        }
        text += decoder.decode(value, { stream: true })
      }
    }

    if (!text) return null
    return bufferedResponse(text, undefined, injects, responseInit)
  }

  const frags = computeInjects({}, injects || {})
  const probeOut = spliceHead(text, frags.head)
  const staged = fontsStage(
    bodyEndStage(withPrefix(probeOut, tailText(reader, decoder)), frags.body),
  )

  return streamedResponse(staged, responseInit)
}

/** Decode the unread remainder of the probe's reader as text pieces. */
async function* tailText(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
): AsyncGenerator<string> {
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const rest = decoder.decode()
        if (rest) yield rest
        return
      }
      const piece = decoder.decode(value, { stream: true })
      if (piece) yield piece
    }
  } finally {
    // Reached on normal EOF (no-op) and when the consumer cancels the response
    // mid-stream — in which case the source must be cancelled too.
    await Try(() => reader.cancel())
  }
}

async function* withPrefix(
  prefix: string,
  rest: AsyncGenerator<string>,
): AsyncGenerator<string> {
  yield prefix
  yield* rest
}

/**
 * Streaming equivalent of `spliceBodyEnd`: insert before the first literal
 * `</body>` (in original casing — the insert slices around the match rather
 * than reconstructing it), else append at the very end. Once inserted the
 * stage is a passthrough, so content it inserted is never rescanned — matching
 * the buffered path's single non-global replace.
 */
async function* bodyEndStage(
  src: AsyncGenerator<string>,
  body: string,
): AsyncGenerator<string> {
  let carry = ''
  let injected = false

  for await (const chunk of src) {
    if (injected) {
      yield chunk
      continue
    }

    const window = carry + chunk
    // Non-global regex: exec ignores lastIndex, safe on the shared instance.
    const match = RX_BODY_END.exec(window)

    if (match) {
      injected = true
      carry = ''
      yield window.slice(0, match.index) + body + window.slice(match.index)
      continue
    }

    const hold = Math.min(window.length, BODY_END_HOLDBACK)
    const emit = window.slice(0, window.length - hold)
    carry = window.slice(window.length - hold)
    if (emit) yield emit
  }

  if (carry) yield carry
  if (!injected && body) yield body
}

/**
 * Streaming equivalent of `rewriteFontsUrls`. Complete matches that start in
 * the emittable region are rewritten (a complete match cannot be invalidated
 * or extended by later input — the pattern has no unbounded or trailing
 * parts); matches or match prefixes inside the holdback stay in the carry for
 * the next window, and the final carry goes through the shared
 * `rewriteFontsUrls` itself.
 */
async function* fontsStage(
  src: AsyncGenerator<string>,
): AsyncGenerator<string> {
  let carry = ''
  // Fresh instance: the module-level RX_GFONTS is `/g` and this loop drives it
  // via exec/lastIndex, which must not be shared across interleaved responses.
  const rx = new RegExp(RX_GFONTS.source, RX_GFONTS.flags)

  for await (const chunk of src) {
    const window = carry + chunk

    if (window.length <= FONTS_HOLDBACK) {
      carry = window
      continue
    }

    const emitEnd = window.length - FONTS_HOLDBACK
    let out = ''
    let last = 0
    let match: RegExpExecArray | null

    // The same fast gate the buffered path uses: no `fonts.goog` in the
    // window means no match in it, and the emit/carry split below does not
    // depend on match presence — a match *prefix* dangling at the window edge
    // sits inside the holdback either way.
    if (window.includes('fonts.goog')) {
      rx.lastIndex = 0
      while ((match = rx.exec(window))) {
        // Starts inside the holdback: defer to the next window (matches are
        // non-overlapping, so nothing already emitted can reach it).
        if (match.index >= emitEnd) break
        out += window.slice(last, match.index) + GFONTS_REWRITE
        last = match.index + match[0].length
      }
    }

    const cut = Math.max(emitEnd, last)
    out += window.slice(last, cut)
    carry = window.slice(cut)
    if (out) yield out
  }

  if (carry) yield rewriteFontsUrls(carry)
}

/**
 * Wrap the staged text into a streaming Response.
 *
 * Deliberately no ETag: a content hash would require buffering the body — the
 * thing this path exists to avoid — and deriving one from anything less (say,
 * source file size+mtime) would keep serving 304s after the config-injected
 * head/body fragments change. Large streamed pages are also where conditional
 * revalidation matters least. Callers relying on the 304 machinery get it on
 * the buffered path, which every params-bearing and small response takes.
 */
function streamedResponse(
  parts: AsyncGenerator<string>,
  responseInit: ResponseInit & { headers?: any },
): Response {
  const headers = new Headers(responseInit?.headers)
  headers.set('Content-Type', 'text/html; charset=utf-8')

  // Buffered responses get `Cache-Control: no-cache` from ETag.sendResponse
  // (guarded the same way: only when the handler set nothing itself). With no
  // ETag that hook never fires here, and a validator-less page left without a
  // cache policy is open to heuristic caching — a stale page, not just a
  // missed 304.
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-cache')
  }

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await parts.next()
      if (done) {
        controller.close()
        return
      }
      if (value) controller.enqueue(encoder.encode(value))
    },
    async cancel() {
      // Runs the generators' finally blocks, which cancel the source reader.
      await Try(() => parts.return(undefined))
    },
  })

  const response = new Response(body, {
    ...responseInit,
    headers,
  })

  return injectBrand(response)
}
