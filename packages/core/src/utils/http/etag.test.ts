import { afterAll, afterEach, beforeEach, describe, test, expect } from 'bun:test'
import { ETag } from './etag'
import { fs } from '../fs'

describe('ETag.sendResponse Set-Cookie handling', () => {
  const etag = ETag.fromText('body')

  function respond(cookies: string[]) {
    const res = new Response('body', { headers: { ETag: etag } })
    for (const c of cookies) res.headers.append('Set-Cookie', c)
    return res
  }

  test('keeps multiple cookies separate instead of collapsing them', () => {
    // `headers.get('Set-Cookie')` joins values with ", "; writing that back as a
    // single header produced one malformed cookie and dropped the rest.
    const req = new Request('http://localhost/')
    const out = ETag.sendResponse(req, respond(['auth=abc; HttpOnly', 'sId=xyz; Path=/']))

    const cookies = out.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    expect(cookies[0]).toContain('auth=abc')
    expect(cookies[1]).toContain('sId=xyz')
  })

  test('carries cookies onto a 304 response', () => {
    const req = new Request('http://localhost/', {
      headers: { 'if-none-match': etag },
    })
    const out = ETag.sendResponse(req, respond(['sId=xyz; Path=/']))

    expect(out.status).toBe(304)
    expect(out.headers.getSetCookie()).toContain('sId=xyz; Path=/')
  })

  test('does not duplicate cookies when the response is unchanged', () => {
    const req = new Request('http://localhost/')
    const out = ETag.sendResponse(req, respond(['sId=xyz; Path=/']))

    expect(out.headers.getSetCookie()).toHaveLength(1)
  })
})

describe('ETag.sendFile variant negotiation memo', () => {
  const dir = fs.resolve(import.meta.dir, '__fixtures__', 'negotiate')
  const base = fs.resolve(dir, 'app.js')
  // Long enough that zstd/gzip output sizes are stable and non-zero.
  const CONTENT = 'export const answer = 42 // '.padEnd(2048, 'x')

  let probes: string[] = []

  async function writeTrio(content = CONTENT, path = base) {
    await Promise.all([
      Bun.write(path, content),
      Bun.write(`${path}.zst`, Bun.zstdCompressSync(content)),
      Bun.write(`${path}.gz`, Bun.gzipSync(content)),
    ])
  }

  /** Callers hand `sendFile` the `.zst` the cache returned, exactly as
   * `getOrCreateCachedFile`'s callers do — negotiation starts from there. */
  function negotiate(acceptEncoding: string, path = base) {
    return ETag.sendFile(
      Bun.file(`${path}.zst`),
      new Request('http://localhost/app.js', {
        headers: acceptEncoding ? { 'Accept-Encoding': acceptEncoding } : {},
      }),
    )
  }

  beforeEach(async () => {
    ETag.__clearNegotiationMemo()
    probes = []
    // Counting probe that keeps the real semantics (convention 9: a seam,
    // not a module mock).
    ETag.__setVariantProbe(path => {
      probes.push(path)
      const file = Bun.file(path)
      if (!fs.exists(file)) return null
      return { size: file.size, mtime: file.lastModified }
    })
    await writeTrio()
  })

  afterEach(() => {
    ETag.__resetVariantProbe()
    ETag.__clearNegotiationMemo()
  })

  afterAll(async () => {
    await fs.rm(fs.resolve(import.meta.dir, '__fixtures__'), {
      recursive: true,
      force: true,
    })
  })

  test('a cold negotiate probes each sibling exactly once', () => {
    const res = negotiate('zstd, gzip')
    expect(res.headers.get('Content-Encoding')).toBe('zstd')
    expect(probes.sort()).toEqual([`${base}.gz`, `${base}.zst`])
  })

  test('a second negotiate of an unchanged file probes no siblings', () => {
    const first = negotiate('zstd, gzip')
    expect(first.headers.get('Content-Encoding')).toBe('zstd')

    probes = []
    const second = negotiate('zstd, gzip')
    expect(second.headers.get('Content-Encoding')).toBe('zstd')
    expect(probes).toEqual([])
    // The remembered etag must be byte-identical to the cold one, or warm
    // hits would break every If-None-Match handed out cold.
    expect(second.headers.get('ETag')).toBe(first.headers.get('ETag'))
  })

  test('the remembered etag matches a fresh stat of the served variant', () => {
    negotiate('zstd, gzip')
    const warm = negotiate('zstd, gzip')
    expect(warm.headers.get('ETag')).toBe(ETag.fromFile(Bun.file(`${base}.zst`)))
  })

  test('a warm hit still answers If-None-Match with 304', () => {
    negotiate('zstd, gzip')
    const etag = negotiate('zstd, gzip').headers.get('ETag')!

    const res = ETag.sendFile(
      Bun.file(`${base}.zst`),
      new Request('http://localhost/app.js', {
        headers: { 'Accept-Encoding': 'zstd, gzip', 'if-none-match': etag },
      }),
    )
    expect(res.status).toBe(304)
  })

  test('a rewritten base (newer mtime) re-probes', async () => {
    const before = negotiate('zstd, gzip')
    // lastModified is millisecond-resolution; make sure the rewrite ticks it.
    await Bun.sleep(20)
    await writeTrio(CONTENT + '!')

    probes = []
    const after = negotiate('zstd, gzip')
    expect(after.headers.get('Content-Encoding')).toBe('zstd')
    expect(probes.length).toBe(2)
    expect(after.headers.get('ETag')).not.toBe(before.headers.get('ETag'))
  })

  test('deleting the variants and touching the base re-probes and finds none', async () => {
    negotiate('zstd, gzip')
    await Bun.sleep(20)
    await fs.rm(`${base}.zst`, { force: true })
    await fs.rm(`${base}.gz`, { force: true })
    await Bun.write(base, CONTENT + '?')

    probes = []
    const res = negotiate('zstd, gzip')
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(probes.length).toBe(2)
    // Identity fallback serves the base file itself.
    expect(await res.text()).toBe(CONTENT + '?')
  })

  test('a wiped cache dir does not serve a remembered variant', async () => {
    // Warm the memo, then simulate the dashboard cache-clear: everything
    // under the cache dir goes, memo entries stay.
    const warm = negotiate('zstd, gzip')
    expect(warm.headers.get('Content-Encoding')).toBe('zstd')

    await fs.rm(dir, { recursive: true, force: true })

    const res = negotiate('zstd, gzip')
    // A missing base must fall through to the base file (the not-found path
    // downstream), never to a remembered .zst that no longer exists.
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(res.headers.get('ETag')).toBe(ETag.fromFile(Bun.file(base)))
  })

  test('a partial variant set is served but never memoized', async () => {
    // User-authored siblings (or a build caught mid-write) can change without
    // the base mtime moving, so an incomplete set must keep fresh-probing.
    await fs.rm(`${base}.gz`, { force: true })

    const first = negotiate('zstd, gzip')
    expect(first.headers.get('Content-Encoding')).toBe('zstd')

    probes = []
    const second = negotiate('zstd, gzip')
    expect(second.headers.get('Content-Encoding')).toBe('zstd')
    expect(probes.length).toBe(2)
  })

  test('Accept-Encoding preference order is unchanged, cold and warm', () => {
    // Cold.
    expect(negotiate('gzip').headers.get('Content-Encoding')).toBe('gzip')
    // Warm, from the entry the call above recorded.
    expect(negotiate('zstd, gzip').headers.get('Content-Encoding')).toBe('zstd')
    expect(negotiate('gzip, zstd').headers.get('Content-Encoding')).toBe('zstd')
    expect(negotiate('gzip').headers.get('Content-Encoding')).toBe('gzip')
    expect(negotiate('identity').headers.get('Content-Encoding')).toBeNull()
    expect(negotiate('').headers.get('Content-Encoding')).toBeNull()
  })

  test('files without a compression suffix bypass negotiation entirely', () => {
    const res = ETag.sendFile(
      Bun.file(base),
      new Request('http://localhost/app.js', {
        headers: { 'Accept-Encoding': 'zstd, gzip' },
      }),
    )
    expect(res.headers.get('Content-Encoding')).toBeNull()
    expect(probes).toEqual([])
  })
})

describe('ETag', () => {
  describe('fromText', () => {
    test('returns a weak etag string', () => {
      const etag = ETag.fromText('hello world')
      expect(etag).toMatch(/^W\/".+"$/)
    })

    test('same text produces same etag', () => {
      expect(ETag.fromText('test')).toBe(ETag.fromText('test'))
    })

    test('different text produces different etag', () => {
      expect(ETag.fromText('a')).not.toBe(ETag.fromText('b'))
    })
  })

  describe('check', () => {
    test('returns 304 Response when etag matches', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText('hello') },
      })
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).not.toBeNull()
      expect(res!.status).toBe(304)
    })

    test('returns null when etag does not match', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText('different') },
      })
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).toBeNull()
    })

    test('returns null when no if-none-match header', () => {
      const req = new Request('http://localhost/')
      const res = ETag.check(req, ETag.fromText('hello'))
      expect(res).toBeNull()
    })

    test('matches wildcard *', () => {
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': '*' },
      })
      const res = ETag.check(req, ETag.fromText('anything'))
      expect(res).not.toBeNull()
      expect(res!.status).toBe(304)
    })
  })

  describe('sendResponse', () => {
    test('returns response unchanged when no ETag header', () => {
      const req = new Request('http://localhost/')
      const res = new Response('body')
      const result = ETag.sendResponse(req, res)
      expect(result.status).toBe(200)
    })

    test('returns 304 when client etag matches', () => {
      const etag = ETag.fromText('content')
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': etag },
      })
      const res = new Response('body', { headers: { ETag: etag } })
      const result = ETag.sendResponse(req, res)
      expect(result.status).toBe(304)
    })
  })

  describe('sendText', () => {
    test('returns text response with ETag header', async () => {
      const res = await ETag.sendText('hello')
      expect(res.headers.get('ETag')).toBeTruthy()
      expect(res.headers.get('Content-Type')).toContain('text/plain')
    })

    test('returns 304 when etag matches', async () => {
      const text = 'hello'
      const req = new Request('http://localhost/', {
        headers: { 'if-none-match': ETag.fromText(text) },
      })
      const res = await ETag.sendText(text, req)
      expect(res.status).toBe(304)
    })
  })
})

describe('ETag.sendText compression offload', () => {
  // Realistic compressible JSON, not pure repetition, so compressed sizes
  // are stable and non-trivial.
  function payload(size: number): string {
    let out = ''
    let i = 0
    while (out.length < size) {
      out += JSON.stringify({ id: i++, name: `item-${i}`, tags: ['a', 'b'] })
    }
    return out.slice(0, size)
  }

  // Above ASYNC_COMPRESSION_MIN (32KB) — the off-thread path.
  const LARGE = payload(96 * 1024)
  // Above the 1KB compression floor, below the 32KB offload cutoff — the
  // path that stays synchronous.
  const SMALL = payload(4 * 1024)

  function reqWith(headers: Record<string, string>) {
    return new Request('http://localhost/data.json', { headers })
  }

  test('offloaded zstd response is byte-identical to the sync path', async () => {
    const res = await ETag.sendText(
      LARGE,
      reqWith({ 'Accept-Encoding': 'zstd, gzip' }),
      'application/json',
    )

    expect(res.headers.get('Content-Encoding')).toBe('zstd')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    // Same etag format the sync path always produced: text hash + variant ext.
    expect(res.headers.get('ETag')).toBe(`${ETag.fromText(LARGE)}.zst`)

    const body = Buffer.from(await res.arrayBuffer())
    expect(Buffer.compare(body, Buffer.from(Bun.zstdCompressSync(LARGE)))).toBe(0)
    expect(new TextDecoder().decode(Bun.zstdDecompressSync(body))).toBe(LARGE)
  })

  test('offloaded gzip response is byte-identical to the sync path', async () => {
    const res = await ETag.sendText(
      LARGE,
      reqWith({ 'Accept-Encoding': 'gzip' }),
      'application/json',
    )

    expect(res.headers.get('Content-Encoding')).toBe('gzip')
    expect(res.headers.get('ETag')).toBe(`${ETag.fromText(LARGE)}.gz`)

    const body = Buffer.from(await res.arrayBuffer())
    expect(Buffer.compare(body, Buffer.from(Bun.gzipSync(LARGE)))).toBe(0)
    expect(new TextDecoder().decode(Bun.gunzipSync(body))).toBe(LARGE)
  })

  test('status survives the async path', async () => {
    const res = await ETag.sendText(
      LARGE,
      reqWith({ 'Accept-Encoding': 'zstd' }),
      'application/json',
      201,
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('Content-Encoding')).toBe('zstd')
  })

  test('below the offload cutoff the response is synchronous and identical', async () => {
    const res = ETag.sendText(
      SMALL,
      reqWith({ 'Accept-Encoding': 'zstd, gzip' }),
      'application/json',
    )

    // The sync contract: small bodies never pay a thread-pool round-trip,
    // and callers that cannot await (none today) would still be correct.
    expect(res).toBeInstanceOf(Response)

    const sync = res as Response
    expect(sync.headers.get('Content-Encoding')).toBe('zstd')
    expect(sync.headers.get('ETag')).toBe(`${ETag.fromText(SMALL)}.zst`)
    const body = Buffer.from(await sync.arrayBuffer())
    expect(Buffer.compare(body, Buffer.from(Bun.zstdCompressSync(SMALL)))).toBe(0)
  })

  test('304 short-circuits before compression, even for an offload-sized body', () => {
    // The etag embeds the negotiated variant ext, computed from headers
    // alone — so a match must return 304 without compressing. A synchronous
    // return is the proof: the only compressing path above the cutoff is the
    // Promise-returning one.
    const etag = `${ETag.fromText(LARGE)}.zst`
    const res = ETag.sendText(
      LARGE,
      reqWith({ 'Accept-Encoding': 'zstd, gzip', 'if-none-match': etag }),
      'application/json',
    )

    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(304)
  })

  test('an uncompressed large response stays synchronous', () => {
    const res = ETag.sendText(LARGE, reqWith({}), 'application/json')
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).headers.get('Content-Encoding')).toBeNull()
  })
})
