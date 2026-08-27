import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../core/config'
import { StaticHandler } from '../handlers/assets/static'
import { processResponse } from '../router'
import { fs } from '../utils/fs'

/**
 * The wire contract for byte ranges on static files, asserted against a real
 * `Bun.serve` because the division of labour spans the process boundary:
 * `ETag.sendFile` advertises (`Accept-Ranges: bytes`), while the slicing
 * itself — 206, `Content-Range`, the appended `Accept-Ranges` on the partial
 * response — happens inside Bun when it serialises a path-backed BunFile
 * body. No unit test of `sendFile` can see the second half, and the first
 * half only matters because of what the second does with it. `Bun.serve`
 * outside `cli/worker.ts` is fine here; the "one Bun.serve" convention check
 * excludes test files.
 *
 * The route through the server is the production funnel minus the worker
 * plumbing: `StaticHandler.handle` → `processResponse` (which is where the
 * BunFile meets `ETag.sendFile`). What these pin:
 *
 * - A plain 200 GET and a HEAD advertise `Accept-Ranges: bytes`. Neither did
 *   before, so players that probe HEAD for it before attempting seeks never
 *   sent a range at all.
 * - A ranged GET still gets its 206 with exact bytes, and carries the header
 *   **once**. Bun appends its own copy when it slices, so the naive fix —
 *   advertise unconditionally — emitted `bytes, bytes` on every 206.
 * - `Content-Disposition` on file responses is Bun's, not the framework's:
 *   the runtime attaches `filename="…"` to any BunFile body whose type
 *   resolves to `application/octet-stream`, on 200 and 206 alike — measured
 *   on Bun 1.4.0, and nothing in this repo writes that header. It carries no
 *   `attachment`, so it forces nothing; it names the file if the client does
 *   download. Kept, and pinned here as *symmetric*, because it was once
 *   reported as a range-response oddity — the asymmetry does not exist, and
 *   suppressing the header at all would mean overriding a runtime default
 *   with an emptier one.
 */

const dir = fs.resolve(import.meta.dir, '__fixtures__', 'static-range')
const MEDIA_SIZE = 64 * 1024

let server: ReturnType<typeof startServer>
let base = ''

function startServer() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      const res = await processResponse(await StaticHandler.handle(path), req)
      return res ?? new Response(null, { status: 500 })
    },
  })
}

beforeAll(async () => {
  await initConfig()
  // `.mp4` and `.bin` on purpose: neither is compressible, so the handler
  // returns the file directly and no `.cache/static` entries are written.
  await Bun.write(fs.resolve(dir, 'video.mp4'), Buffer.alloc(MEDIA_SIZE, 7))
  await Bun.write(fs.resolve(dir, 'blob.bin'), Buffer.alloc(4096, 3))
  __setTestConfig({ root: dir } as any)

  server = startServer()
  base = `http://localhost:${server.port}`
})

afterAll(async () => {
  server?.stop(true)
  __resetTestConfig()
  await fs.rm(dir, { recursive: true, force: true })
})

describe('static files over the wire — range advertisement', () => {
  test('a plain 200 GET advertises Accept-Ranges: bytes', async () => {
    const res = await fetch(`${base}/video.mp4`)
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-range')).toBeNull()
    expect((await res.arrayBuffer()).byteLength).toBe(MEDIA_SIZE)
  })

  test('a HEAD advertises too, with the full length and no body', async () => {
    const res = await fetch(`${base}/video.mp4`, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe(String(MEDIA_SIZE))
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })

  test('a ranged GET is a 206 with exact bytes and the header exactly once', async () => {
    const res = await fetch(`${base}/video.mp4`, {
      headers: { Range: 'bytes=100-199' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes 100-199/${MEDIA_SIZE}`,
    )
    expect((await res.arrayBuffer()).byteLength).toBe(100)
    // `get` joins duplicates with ", " — the double-advertisement regression
    // would read `bytes, bytes` here.
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  test('a suffix range resolves against the true length', async () => {
    const res = await fetch(`${base}/video.mp4`, {
      headers: { Range: 'bytes=-100' },
    })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(
      `bytes ${MEDIA_SIZE - 100}-${MEDIA_SIZE - 1}/${MEDIA_SIZE}`,
    )
    expect(res.headers.get('accept-ranges')).toBe('bytes')
  })

  test("the framework's own headers survive Bun's slicing", async () => {
    const full = await fetch(`${base}/video.mp4`)
    const part = await fetch(`${base}/video.mp4`, {
      headers: { Range: 'bytes=0-9' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('etag')).toBe(full.headers.get('etag'))
    await full.arrayBuffer()
    await part.arrayBuffer()
  })
})

describe('static files over the wire — Content-Disposition is symmetric', () => {
  test('an octet-stream file carries it on 200 and 206 alike', async () => {
    const full = await fetch(`${base}/blob.bin`)
    expect(full.status).toBe(200)
    expect(full.headers.get('content-disposition')).toContain('blob.bin')
    await full.arrayBuffer()

    const part = await fetch(`${base}/blob.bin`, {
      headers: { Range: 'bytes=0-9' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-disposition')).toBe(
      full.headers.get('content-disposition'),
    )
    await part.arrayBuffer()
  })

  test('a typed file carries it nowhere', async () => {
    const full = await fetch(`${base}/video.mp4`)
    expect(full.headers.get('content-disposition')).toBeNull()
    await full.arrayBuffer()

    const part = await fetch(`${base}/video.mp4`, {
      headers: { Range: 'bytes=0-9' },
    })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-disposition')).toBeNull()
    await part.arrayBuffer()
  })
})
