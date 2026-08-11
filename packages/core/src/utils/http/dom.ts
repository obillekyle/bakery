import { LRUCache } from '../../cache/lru'
import { Bakery, hostStore } from '../../core/bakery'
import type { MapOf } from '../../types'
import { is } from '../common/misc'
import { Try } from '../common/try'
import { fs } from '../fs'
import { escapeScriptJson } from '../isomorphic/escape'

// Keyed by hostname, which comes from the Host header — bounded so a client
// cannot grow it without limit by varying that header per request.
const headBodyCache = new LRUCache<string, { head: string; body: string }>(64)

export function clearHeadBodyCache() {
  headBodyCache.clear()
}

export { headBodyCache }

let depMap = ''

const hostDepMaps = new Map<string, string>()

/**
 * Normalise one import-map entry, for both the process-level map and the
 * per-host maps.
 *
 * There used to be two copies of this, and they had drifted into disagreeing
 * about *what* they tested: `initHostImportMaps` switched on the entry key,
 * `initImportMap` tested the entry value. `{ foo: './.server/client/utils' }`
 * was rewritten by one path and silently left alone by the other. One helper,
 * two callers, so they cannot disagree again.
 *
 * The `.server/client/utils` special cases both copies carried are gone rather
 * than reconciled. `.server/` is the pre-split layout: those two string
 * literals were the last references to it anywhere in `packages`, `apps`,
 * `docs` or `tests`, and the directory they name no longer exists, so a value
 * pointing at it is a broken path either way. It normalises as an ordinary
 * relative specifier now.
 *
 * `@client/utils` stays, and stays keyed on the *key*: it is a live alias — it
 * is the default `importMap` entry in `core/config.ts` — and the browser
 * runtime is served from a fixed URL, so the target is not the app's to choose.
 */
function normalizeImportEntry(key: string, value: unknown): [string, string] {
  const cleanKey = key.replace(/\*$/, '')
  const cleanVal = String(value).replace(/\*$/, '')

  if (cleanKey === '@client/utils') return [cleanKey, '/_client/utils.js']

  return [
    cleanKey,
    cleanVal.replace(/^\.(?=\/)/, '').replace(/^(?!(?:\/|https?:\/\/))/, '/'),
  ]
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
      const [key, value] = normalizeImportEntry(k, v)
      imports[key] = value
    }

    hostDepMaps.set(hostname, JSON.stringify({ imports }))
  }
}

// `resolveDepModule` stood here: a hand-rolled `browser`/`module`/`main` pick,
// deleted rather than kept "just in case". `Bun.build` behind `/_nm/` does the
// same job against the real resolution algorithm — `exports` maps and
// conditions included, which this understood not at all — and the import map no
// longer names an entry point for it to compute. See `initImportMap`.

/**
 * Build the browser import map from the app's dependencies.
 *
 * **It maps a package to `/_nm/<name>` and stops there.** It used to read every
 * dependency's `package.json` and pick an entry point itself — `module`, then
 * `main`, then a `browser` override — producing `/_nm/<name>/<entry>`. That
 * duplicated, less well, what the other end of the URL already does:
 * `NMHandler` hands the path to `Bun.build`, which applies real browser
 * resolution including `exports` maps, conditions and the `browser` field. The
 * hand-rolled version understood none of those, so a package whose entry lives
 * behind an `exports` map resolved to the wrong file or to nothing.
 *
 * Verified with a package whose `main`, `module` and `browser` point at three
 * different files: with no map entry at all, `/_nm/<name>` serves the **browser**
 * one. The resolution was never needed here.
 *
 * Two consequences worth stating. It no longer reads N `package.json` files on
 * every boot. And an app-declared `importMap` entry still wins — those are
 * aliases the app means, and one of them (`@client/utils`) does not point into
 * `node_modules` at all.
 *
 * **The map still exists, and removing it entirely would be a regression.** Code
 * the compiler never sees — an inline `<script type="module">` in an `.html`
 * page — reaches the browser with its bare specifiers intact, and the map is the
 * only thing that resolves them there.
 */
export async function initImportMap() {
  const pkgContent = await Try(() =>
    Bun.file(fs.resolve(fs.cwd, 'package.json')).json(),
  )
  const pkg: any = pkgContent || {}
  const map = Bakery.config.importMap || {}
  const deps = pkg.dependencies || {}

  const resolvedMap: MapOf<string> = {}

  for (const dep of Object.keys(deps)) {
    resolvedMap[`${dep}/`] = `/_nm/${dep}/`
    resolvedMap[dep] = `/_nm/${dep}`
  }

  for (const [k, v] of Object.entries(map)) {
    const [key, value] = normalizeImportEntry(k, v)
    resolvedMap[key] = value
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
