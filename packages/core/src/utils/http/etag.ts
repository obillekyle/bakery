import type { MapOf, MixedPromise } from '../../types'
import { LRUCache } from '../../cache/lru'
import { ASYNC_COMPRESSION_MIN, COMPRESSION_MAP, fs } from '../fs'

export namespace ETag {
  function tag(response: Response): Response {
    ;(response as any).__notModified__ = true
    return response
  }

  export function isNotModified(response: Response): boolean {
    return !!(response as any).__notModified__
  }

  export function fromText(content: string | Uint8Array): string {
    const hash = Bun.hash(content)
    return `W/"${hash.toString(36)}"`
  }

  /** The one writer of the file-etag format — `fromFile` and the negotiation
   * memo below must agree byte-for-byte, or a warm hit would break every
   * `If-None-Match` a cold response handed out. */
  function fileTag(size: number, mtime: number): string {
    return `W/"${size.toString(36)}-${(mtime || 0).toString(36)}"`
  }

  export function fromFile(file: Bun.BunFile): string {
    return fileTag(file.size, file.lastModified)
  }

  export function check(req: Request, etag: string): Response | null {
    const ifNoneMatch = req.headers.get('if-none-match')
    if (ifNoneMatch) {
      const clientEtags = ifNoneMatch
        .split(',')
        .map(s => s.trim().replace(/^W\//, ''))
      const cleanEtag = etag.replace(/^W\//, '')

      if (clientEtags.includes(cleanEtag) || clientEtags.includes('*')) {
        return tag(
          new Response(null, {
            status: 304,
            headers: {
              ETag: etag,
              'Cache-Control': 'no-cache',
            },
          }),
        )
      }
    }
    return null
  }

  export function sendResponse(req: Request, response: Response): Response {
    const etag = response.headers.get('ETag')
    if (!etag) return response

    // getSetCookie() keeps each cookie separate. `.get()` joins them with ", ",
    // which then gets written back as one malformed header.
    const cookies = response.headers.getSetCookie()
    response = isNotModified(response) ? response : check(req, etag) || response

    if (!response.headers.has('Cache-Control')) {
      response.headers.set('Cache-Control', 'no-cache')
    }

    if (cookies.length && !response.headers.has('Set-Cookie')) {
      for (const cookie of cookies) {
        response.headers.append('Set-Cookie', cookie)
      }
    }

    return response
  }

  type VariantStat = { size: number; mtime: number }
  type VariantRecord = { encoding: string; ext: string } & VariantStat

  /**
   * Per-base-path record of which compressed siblings exist, anchored on the
   * base file's mtime. `getOrCreateCachedFile` — the only writer of these
   * files — writes the raw file and every variant together in one
   * `Promise.all`, so the base mtime changes whenever the variant set does;
   * that makes the mtime the invalidation signal, and no write-side hook is
   * needed (fs.ts stays unaware of this module, keeping the dependency arrow
   * fs ← etag one-way).
   *
   * An `LRUCache`, not a Map: base paths derive from request paths via the
   * hostKey'd cache names, and an unbounded map keyed on client-derived input
   * is what convention 6 forbids. 512 entries covers the working set of
   * distinct cached assets at ~100 bytes each.
   *
   * Only *complete* variant sets are recorded. A partial set means either a
   * build caught mid-write (the trio lands over a few ms) or user-authored
   * precompressed siblings next to a served `.gz` — in both cases the set can
   * change without the base mtime moving, so those fall back to per-request
   * probing, which is exactly the pre-memo behavior.
   */
  type NegotiationEntry = { mtime: number; variants: VariantRecord[] }
  const negotiationMemo = new LRUCache<string, NegotiationEntry>(512)

  /**
   * One stat, and the values are kept rather than discarded: a `BunFile`
   * caches its stat on first property access (~66us fresh, ~40ns after), so
   * routing the probe through `fs.exists` — which stats a throwaway instance —
   * made every served variant pay a second, identical stat in `fromFile`.
   * Same existence predicate as `fs.exists`; note a missing file reports
   * size 0 and a far-future sentinel `lastModified`, never 0.
   */
  function statVariant(path: string): VariantStat | null {
    const file = Bun.file(path)
    const mtime = file.lastModified
    const size = file.size
    if ((mtime && mtime < Date.now()) || size > 0) return { size, mtime }
    return null
  }

  let probeVariant: (path: string) => VariantStat | null = statVariant

  /**
   * Test seam (convention 9): lets etag.test.ts count sibling probes without
   * module-mocking `bun` or `node:fs` — which is process-global and never
   * unwinds. Same shape as `fs.__setForbiddenProbe`.
   */
  export function __setVariantProbe(fn: (path: string) => VariantStat | null) {
    probeVariant = fn
  }

  export function __resetVariantProbe() {
    probeVariant = statVariant
  }

  /** Test seam: the memo is process-global and mtime-keyed, so tests that
   * rebuild fixtures at the same path must start from a clean slate. */
  export function __clearNegotiationMemo() {
    negotiationMemo.clear()
  }

  function negotiateFile(file: Bun.BunFile, req?: Request) {
    const fileName = file.name || 'file'

    const matchedExt = COMPRESSION_MAP.find(c => fileName.endsWith(c.ext))?.ext

    if (!req || !matchedExt) {
      return {
        resolvedFile: file,
        fileHeaders: {} as MapOf<any>,
        etag: undefined as string | undefined,
      }
    }

    const basePath = fileName.slice(0, -matchedExt.length)
    const ext = basePath.split('.').pop() || ''
    const acceptEncoding = req.headers.get('Accept-Encoding') || ''

    const fileHeaders: MapOf<any> = {
      'Content-Type': fs.getMimeType(ext),
      'Cache-Control': 'no-cache',
    }

    const baseFile = Bun.file(basePath)
    let resolvedFile = baseFile
    let etag: string | undefined

    if (fs.isCompressible(ext)) {
      // The freshness anchor, and the only stat this function performs on a
      // warm hit. The instance doubles as the identity-path `resolvedFile`,
      // so `fromFile` in `sendFile` reads the same cached stat rather than
      // paying a second one.
      const baseMtime = baseFile.lastModified
      const baseExists = Boolean(
        (baseMtime && baseMtime < Date.now()) || baseFile.size > 0,
      )

      // The memo is consulted only for a base that exists right now, and only
      // when its recorded mtime matches the anchor exactly — a wiped cache
      // dir (missing base reports the far-future sentinel mtime) or any
      // rewrite falls through to a fresh probe.
      let entry = baseExists ? negotiationMemo.get(basePath) : undefined
      if (entry && entry.mtime !== baseMtime) {
        entry = undefined
      }

      if (!entry) {
        const variants: VariantRecord[] = []
        for (const { encoding, ext: compExt } of COMPRESSION_MAP) {
          const stat = probeVariant(`${basePath}${compExt}`)
          if (stat) variants.push({ encoding, ext: compExt, ...stat })
        }
        entry = { mtime: baseMtime, variants }
        if (baseExists && variants.length === COMPRESSION_MAP.length) {
          negotiationMemo.set(basePath, entry)
        } else {
          // A deleted base (cache-dir wipe) or a partial set: drop any stale
          // record so nothing ever resolves to a remembered variant whose
          // files are gone.
          negotiationMemo.delete(basePath)
        }
      }

      // `variants` is in COMPRESSION_MAP order, so client preference
      // resolution is unchanged from the probe loop it replaces.
      for (const variant of entry.variants) {
        if (acceptEncoding.includes(variant.encoding)) {
          resolvedFile = Bun.file(`${basePath}${variant.ext}`)
          fileHeaders['Content-Encoding'] = variant.encoding
          etag = fileTag(variant.size, variant.mtime)
          break
        }
      }
    }

    return { resolvedFile, fileHeaders, etag }
  }

  export function sendFile(file: Bun.BunFile, req?: Request): Response {
    const { resolvedFile, fileHeaders, etag: negotiated } = negotiateFile(
      file,
      req,
    )

    const headers: MapOf<any> = fileHeaders

    const etag = negotiated || ETag.fromFile(resolvedFile)
    headers.ETag = etag

    if (req) {
      const conditionalRes = ETag.check(req, etag)
      if (conditionalRes) return conditionalRes
    }

    return new Response(resolvedFile, { headers })
  }

  /**
   * Returns synchronously on every path that does not compress — no request,
   * small body, unsupported Accept-Encoding, and crucially the 304
   * short-circuit — and returns a Promise only when compression actually
   * runs on a body large enough to offload (`ASYNC_COMPRESSION_MIN`). The
   * one call site that can receive either (`processResponse`) awaits.
   */
  export function sendText(
    text: string,
    req?: Request,
    type = '',
    status = 200,
  ): MixedPromise<Response> {
    type ||= 'text/plain; charset=utf-8'
    if (typeof status !== 'number' || isNaN(status) || status < 100 || status > 599) {
      status = 200
    }

    let appliedExt = ''
    let encoder: ((text: string) => Uint8Array) | null = null
    let encoderAsync: ((text: string) => Promise<Uint8Array>) | null = null
    let encodingName = ''
    const headers: MapOf<any> = {
      'Content-Type': type,
    }

    // Negotiation only — no compression yet. The ext suffix the etag embeds
    // is decided by the Accept-Encoding header alone, so the 304 check can
    // run first: a client that already holds the body must not cost a
    // zstd pass whose output is then thrown away.
    if (req && text.length > 1024) {
      const acceptEncoding = req.headers.get('Accept-Encoding') || ''

      for (const { encoding, ext, compress, compressAsync } of COMPRESSION_MAP) {
        if (acceptEncoding.includes(encoding) && compress) {
          encoder = compress as any
          encoderAsync = compressAsync as any
          encodingName = encoding
          appliedExt = ext
          break
        }
      }
    }

    const baseEtag = ETag.fromText(text)
    const finalEtag = appliedExt ? `${baseEtag}${appliedExt}` : baseEtag
    headers.ETag = finalEtag

    if (req) {
      const conditionalRes = ETag.check(req, finalEtag)
      if (conditionalRes) return conditionalRes
    }

    if (encoder) {
      headers['Content-Encoding'] = encodingName

      // Off the request thread for large bodies: the sync pass measured
      // ~700us of event-loop stall per 135KB response. Below the cutoff the
      // pool round-trip costs more than the stall it removes — numbers on
      // `ASYNC_COMPRESSION_MIN` in fs.ts.
      if (encoderAsync && text.length >= ASYNC_COMPRESSION_MIN) {
        return encoderAsync(text).then(
          payload => new Response(payload as any, { headers, status }),
        )
      }

      return new Response(encoder(text) as any, { headers, status })
    }

    return new Response(text, { headers, status })
  }
}
