import { LRUCache } from '../../cache/lru'
import { Bakery } from '../../core/bakery'
import { toHash } from '../../utils/common/case'
import { COMPRESSION_MAP, FileSystem as fs } from '../../utils/fs'
import { response } from '../../utils/http'
import { Handler } from '../core/$base'

/**
 * The Google Fonts CSS endpoints this proxy is willing to forward to.
 *
 * `css` is the v1 API, `css2` the current one, `icon` the Material icon
 * stylesheet. Everything else on `fonts.googleapis.com` — and anything at all
 * once the path is attacker-supplied — is refused, because this handler is an
 * unauthenticated outbound fetch from the server's own IP and the path used to
 * be forwarded verbatim.
 */
const GF_CSS_PATHS = new Set(['css', 'css2', 'icon'])

/**
 * The documented Google Fonts query parameters.
 *
 * Google answers `200` for a request carrying parameters it does not know, so
 * before this list every `?family=Roboto&junk=<n>` was a fresh cache key *and*
 * a fresh outbound request: six junk requests were measured producing six keys
 * and eighteen files. Names are compared raw, without percent-decoding — a
 * name spelled `%66amily` simply fails the list, which is the safe direction.
 */
const GF_CSS_PARAMS = new Set([
  'display',
  'effect',
  'family',
  'icon_names',
  'subset',
  'text',
])

const GF_MAX_PARAMS = 12
const GF_MAX_QUERY = 512
const GF_MAX_GSTATIC_PATH = 256

/**
 * A path under `fonts.gstatic.com`, as the rewritten CSS references it —
 * `s/roboto/v47/KFOmCnqEu92Fr1Mu4mxK.woff2`.
 *
 * Every segment must start with an alphanumeric, which is what rules out `..`
 * and an empty segment (`//`) without a second pass over the string, and the
 * extension list keeps this to font payloads.
 */
const GF_GSTATIC_PATH =
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*\.(?:woff2?|ttf|otf|eot|svg)$/

/**
 * How many distinct upstream assets this handler will keep on disk.
 *
 * `getOrCreateCachedFile` writes three files per entry (raw, `.zst`, `.gz`)
 * and nothing ever removed them, so the cache directory grew with the number
 * of distinct request URLs — which is to say, without bound. The allow-lists
 * above shrink the key space but do not close it: a family *name* is still
 * free text, and a wrong one costs a 400 from Google rather than a rejection
 * here. This is the bound, in the shape convention 6 asks for.
 *
 * The index is per-process and the files are not, so a restart forgets which
 * files it was tracking. That leaves at most one generation of stale files
 * behind rather than an unbounded pile, and re-requesting an entry re-adopts
 * it; a cache directory is disposable by design.
 */
const GF_MAX_ENTRIES = 256

const cacheIndex = new LRUCache<string, string>(
  GF_MAX_ENTRIES,
  (_key, rawPath) => {
    void fs.rm(rawPath, { force: true })
    for (const { ext } of COMPRESSION_MAP) {
      void fs.rm(`${rawPath}${ext}`, { force: true })
    }
  },
)

/** Record a cache entry against the bound, evicting the oldest if it is full. */
function trackCacheEntry(cacheDir: string, cacheName: string): void {
  const rawPath = fs.resolve(cacheDir, cacheName)
  cacheIndex.set(rawPath, rawPath)
}

/**
 * Test seams for the bound, in the `__`-prefixed style of `__setTestConfig`.
 *
 * Every other branch of this handler is reachable from a test through
 * `handle()` — the allow-lists refuse before anything is fetched. The eviction
 * path is not: reaching it legitimately means 257 successful round trips to
 * Google, which is not a unit test. These let one assert the bound holds and
 * that an evicted entry takes its `.zst`/`.gz` companions with it.
 */
export const __gfTrackCacheEntry = trackCacheEntry
export const __gfCacheIndex: ReadonlyMap<string, string> = cacheIndex
export const __gfMaxEntries = GF_MAX_ENTRIES

/**
 * The query, validated and put in a canonical order, or `null` if it carries
 * anything undocumented.
 *
 * Pairs are sorted as raw text rather than re-encoded through
 * `URLSearchParams`: sorting collapses `?family=X&display=swap` and
 * `?display=swap&family=X` onto one cache key and one upstream request, while
 * leaving each pair's bytes exactly as the client sent them. Re-encoding would
 * turn the `:`, `@` and `;` of a `family=Roboto:wght@400;700` axis spec into
 * percent escapes and change the request going upstream, which is not a thing
 * to do on a live third-party API for a cosmetic win.
 */
function canonicalQuery(search: string): string | null {
  const raw = search.startsWith('?') ? search.slice(1) : search
  if (!raw) return ''
  if (raw.length > GF_MAX_QUERY) return null

  const pairs = raw.split('&')
  if (pairs.length > GF_MAX_PARAMS) return null

  for (const pair of pairs) {
    const name = pair.split('=')[0]
    if (!GF_CSS_PARAMS.has(name)) return null
  }

  return `?${pairs.sort().join('&')}`
}

export class GoogleFontHandler extends Handler {
  static get cacheDir() {
    return fs.resolve(Bakery.cacheDir, 'gf_cache')
  }

  static canHandle(path: string): boolean {
    return path === '/_gf' || path.startsWith('/_gf/')
  }

  static async handle(path: string, req: Request) {
    if (path.startsWith('/_gf/gstatic/')) {
      return this.handleGstatic(path)
    }

    const rawPath = path.slice('/_gf'.length)
    const strippedPath = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
    const gfPath = strippedPath || 'css2'

    if (!GF_CSS_PATHS.has(gfPath)) {
      return response.error('Unknown Google Fonts endpoint', 404)
    }

    const url = new URL(req.url)
    const searchQuery = canonicalQuery(url.search)
    if (searchQuery === null) {
      return response.error('Unsupported Google Fonts query', 400)
    }

    const cacheKey = `${gfPath}${searchQuery}`
    const cacheName = `${toHash(cacheKey)}.css`
    const cacheDir = this.cacheDir

    const cached = await fs.getOrCreateCachedFile(
      cacheDir,
      cacheName,
      null,
      async () => {
        const gfUrl = `https://fonts.googleapis.com/${gfPath}${searchQuery}`

        const res = await fetch(gfUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        })

        if (!res.ok) return null

        let css = await res.text()
        css = css.replace(/https?:\/\/fonts\.gstatic\.com/g, '/_gf/gstatic')

        return css
      },
    )

    if (!cached) return response.error('Failed to fetch Google Fonts CSS', 502)

    trackCacheEntry(cacheDir, cacheName)
    return cached
  }

  private static async handleGstatic(path: string) {
    const gstaticPath = path.slice('/_gf/gstatic/'.length)

    // Refused before `this.cacheDir` is read, so a rejection costs neither a
    // config lookup nor a path resolution.
    if (
      gstaticPath.length > GF_MAX_GSTATIC_PATH ||
      !GF_GSTATIC_PATH.test(gstaticPath)
    ) {
      return response.error('Unknown Google Fonts asset', 404)
    }

    const cacheDir = fs.resolve(this.cacheDir, 'gstatic')
    const cacheExt = `${fs.parse(gstaticPath).ext || '.bin'}`
    const cacheName = `${toHash(gstaticPath)}${cacheExt}`

    const cached = await fs.getOrCreateCachedFile(
      cacheDir,
      cacheName,
      null,
      async () => {
        const gfUrl = `https://fonts.gstatic.com/${gstaticPath}`
        const res = await fetch(gfUrl)

        if (!res.ok) return null

        return res.arrayBuffer()
      },
    )

    if (!cached) {
      return response.error('Failed to fetch Google Fonts asset', 502)
    }

    trackCacheEntry(cacheDir, cacheName)
    return cached
  }
}
