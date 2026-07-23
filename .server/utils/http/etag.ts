import { COMPRESSION_MAP, fs } from '../fs'

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

  export function fromFile(file: Bun.BunFile): string {
    const sizePart = file.size.toString(36)
    const mtimePart = (file.lastModified || 0).toString(36)
    return `W/"${sizePart}-${mtimePart}"`
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

    const cookie = response.headers.get('Set-Cookie')
    response = isNotModified(response) ? response : check(req, etag) || response

    if (!response.headers.has('Cache-Control')) {
      response.headers.set('Cache-Control', 'no-cache')
    }
    cookie && response.headers.set('Set-Cookie', cookie)

    return response
  }

  function negotiateFile(file: Bun.BunFile, req?: Request) {
    const fileName = file.name || 'file'

    const matchedExt = COMPRESSION_MAP.find(c => fileName.endsWith(c.ext))?.ext

    if (!req || !matchedExt) {
      return { resolvedFile: file, fileHeaders: {} }
    }

    const basePath = fileName.slice(0, -matchedExt.length)
    const ext = basePath.split('.').pop() || ''
    const acceptEncoding = req.headers.get('Accept-Encoding') || ''

    const fileHeaders: MapOf<any> = {
      'Content-Type': fs.getMimeType(ext),
      'Cache-Control': 'no-cache',
    }

    let resolvedFile = Bun.file(basePath)

    if (fs.isCompressible(ext)) {
      for (const { encoding, ext: compExt } of COMPRESSION_MAP) {
        const compFile = Bun.file(`${basePath}${compExt}`)

        if (acceptEncoding.includes(encoding) && fs.exists(compFile)) {
          resolvedFile = compFile
          fileHeaders['Content-Encoding'] = encoding
          break
        }
      }
    }

    return { resolvedFile, fileHeaders }
  }
  export function sendFile(file: Bun.BunFile, req?: Request): Response {
    const { resolvedFile, fileHeaders } = negotiateFile(file, req)

    const headers: MapOf<any> = fileHeaders

    const etag = ETag.fromFile(resolvedFile)
    headers.ETag = etag

    if (req) {
      const conditionalRes = ETag.check(req, etag)
      if (conditionalRes) return conditionalRes
    }

    return new Response(resolvedFile, { headers })
  }

  export function sendText(text: string, req?: Request, type = ''): Response {
    type ||= 'text/plain; charset=utf-8'

    let payload: string | Uint8Array<ArrayBuffer> = text
    let appliedExt = ''
    const headers: MapOf<any> = {
      'Content-Type': type,
    }

    if (req && text.length > 1024) {
      const acceptEncoding = req.headers.get('Accept-Encoding') || ''

      for (const { encoding, ext, compress } of COMPRESSION_MAP) {
        if (acceptEncoding.includes(encoding) && compress) {
          payload = compress(text) as any
          headers['Content-Encoding'] = encoding
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

    return new Response(payload, { headers })
  }
}
