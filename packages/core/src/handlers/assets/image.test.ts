import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Bakery } from '../../core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { ImageHandler } from './image'

/**
 * `ImageHandler` re-encodes on demand: `/pics/photo;128.png` means "that image,
 * shortest side about 128", and the answer is written to `.cache/images/`.
 *
 * The size therefore comes from the URL, which makes it **client-supplied
 * input that spends CPU and disk**. Left alone it is convention 6's exact
 * failure mode: `;16`, `;17`, `;18` … are 4081 distinct cache entries and 4081
 * full WebP encodes from a single image, reachable by anyone who can type a
 * URL, and no eviction anywhere because these are files rather than an LRU.
 *
 * `clampSize` — `Math2.clamp(Math2.step(size, 32), 16, maxImageSize)` — is what
 * bounds it, and this file pins it from the outside: the observable is the
 * cache *filename*, because that is the thing the cache is keyed by and the
 * thing an attacker would be multiplying. Asserting the private helper's return
 * value would pass just as happily if `handle` stopped calling it.
 *
 * A 300x200 source is generated in `beforeAll` rather than committed, so the
 * fixture is one base64 pixel and the resize is visible in the test.
 */

/** A 1x1 red PNG; scaled up below to give the resize something to work on. */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const SOURCE_W = 300
const SOURCE_H = 200

describe('ImageHandler', () => {
  let dir: string
  let cacheImages: string
  const realRoot = Bakery.root
  const realCache = Bakery.cacheDir

  /** Every file currently in `.cache/images/`. */
  const cached = async () => (await readdir(cacheImages)).sort()

  /** `handle`, asserting it answered with a file rather than an error. */
  const serve = async (path: string) => {
    const res = await ImageHandler.handle(path)
    if (res instanceof Response) {
      throw new Error(`${path} -> ${res.status} ${await res.text()}`)
    }
    return res as Bun.BunFile
  }

  const servedName = async (path: string) => basename((await serve(path)).name!)

  beforeAll(async () => {
    await initConfig()
    dir = await mkdtemp(join(tmpdir(), 'bakery-image-'))
    cacheImages = join(dir, '.cache', 'images')

    await mkdir(join(dir, 'pics'), { recursive: true })
    await Bun.write(join(dir, 'seed.png'), Buffer.from(PNG_1X1, 'base64'))
    await Bun.file(join(dir, 'seed.png'))
      .image()
      .resize(SOURCE_W, SOURCE_H)
      .png()
      .write(join(dir, 'pics/photo.png'))

    // Same swap-and-restore as `nm.test.ts`: `root` and `cacheDir` are plain
    // writable properties on the service locator (readonly in the ambient type
    // only), and `serveRoot` reads `config.root`, which is what the config seam
    // is for. No module mocks — convention 9.
    __setTestConfig({ root: dir })
    ;(Bakery as any).root = dir
    ;(Bakery as any).cacheDir = join(dir, '.cache')
  })

  afterAll(async () => {
    __resetTestConfig()
    ;(Bakery as any).root = realRoot
    ;(Bakery as any).cacheDir = realCache
    await rm(dir, { recursive: true, force: true })
  })

  test('canHandle claims image extensions only', () => {
    expect(ImageHandler.canHandle('/pics/photo.png')).toBe(true)
    expect(ImageHandler.canHandle('/pics/photo;128.webp')).toBe(true)
    expect(ImageHandler.canHandle('/pics/photo.txt')).toBe(false)
    expect(ImageHandler.canHandle('/pics/photo')).toBe(false)
  })

  test('an unsized request serves the master encode', async () => {
    const name = await servedName('/pics/photo.png')

    expect(name).toEndWith('-main.webp')
    // The source is a PNG and the answer is a WebP: this really is the
    // re-encode path and not the file off disk.
    expect(await Bun.file(join(cacheImages, name)).exists()).toBe(true)
  })

  test('a missing image is a 404, not a 500', async () => {
    const res = await ImageHandler.handle('/pics/nothing-here.png')
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })

  /**
   * The headline. Thirty-one distinct URLs, one cache entry.
   *
   * `Math2.step(size, 32)` rounds to the nearest multiple of 32, so everything
   * from `;17` to `;47` is the same picture and gets the same filename. Without
   * the step each of these is its own file and its own encode, which is the
   * unbounded cache the comment in `image.ts` describes.
   */
  test('nearby sizes collapse onto one bucket', async () => {
    const before = await cached()

    const names = await Promise.all(
      [17, 20, 31, 32, 33, 40, 47].map(n => servedName(`/pics/photo;${n}.png`)),
    )

    expect(new Set(names).size).toBe(1)
    expect(names[0]).toEndWith('-32.webp')

    // And exactly one file appeared for the seven requests.
    const added = (await cached()).filter(f => !before.includes(f))
    expect(added).toEqual([names[0]])
  })

  test('a different bucket is a different entry, and really is resized', async () => {
    const name = await servedName('/pics/photo;64.png')
    expect(name).toEndWith('-64.webp')

    const meta = await Bun.file(join(cacheImages, name)).image().metadata()
    // `scale` is driven by the shortest side, so 200 -> 64 and 300 -> 96.
    expect(Math.min(meta.width, meta.height)).toBe(64)
  })

  /**
   * The floor. `Math2.step(1, 32)` is 0 — a zero-pixel resize — so the clamp is
   * doing real work here and not just tidying the range.
   *
   * The list stops at 15 on purpose: `step` rounds to *nearest*, and 16 is
   * exactly half a step, which `Math.round` sends up to 32. So 16 is the value
   * of the floor and not a request that reaches it.
   */
  test('sizes below the floor clamp to 16', async () => {
    const names = await Promise.all(
      [1, 2, 8, 15].map(n => servedName(`/pics/photo;${n}.png`)),
    )

    expect(new Set(names).size).toBe(1)
    expect(names[0]).toEndWith('-16.webp')
    expect(await servedName('/pics/photo;16.png')).toEndWith('-32.webp')
  })

  /**
   * The ceiling, and the one that matters for a hostile caller: a size in the
   * billions is what turns one request into an out-of-memory resize. It is
   * pinned against `maxImageSize` rather than a literal, so raising the limit
   * does not silently make this test meaningless.
   */
  test('an absurd size clamps to maxImageSize', async () => {
    const suffix = `-${ImageHandler.maxImageSize}.webp`

    const names = await Promise.all(
      ['9999', '4294967296', '9999999999999999999999999'].map(n =>
        servedName(`/pics/photo;${n}.png`),
      ),
    )

    expect(new Set(names).size).toBe(1)
    expect(names[0]).toEndWith(suffix)

    // Clamped, so no upscale: the answer is still the source's own size.
    const meta = await Bun.file(join(cacheImages, names[0])).image().metadata()
    expect(meta.width).toBe(SOURCE_W)
    expect(meta.height).toBe(SOURCE_H)
  })

  /**
   * A non-numeric size cannot reach the sizing path at all: `IMAGE_CAPTURE`
   * only captures `;(\d+)`, and a `;` that is not followed by digits ends up
   * inside the *directory* part of the match, so the file simply does not
   * resolve. Worth pinning because "parse the size" is the obvious place for a
   * `NaN` to slip past a clamp — `Math2.clamp(NaN, 16, 4096)` is `NaN`, and a
   * `-NaN.webp` cache entry would be one per distinct spelling.
   */
  test('a non-numeric size resolves nothing rather than escaping the clamp', async () => {
    for (const bad of ['abc', '-1', '1e9', '32.5', '0x40']) {
      const res = await ImageHandler.handle(`/pics/photo;${bad}.png`)
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(404)
    }

    expect((await cached()).some(f => f.includes('NaN'))).toBe(false)
  })

  /**
   * The cache id is hashed from the *resolved source*, not the request path —
   * the fix the comment in `image.ts` records. Every entry above therefore
   * shares one id, and the whole directory after all of this is one master plus
   * one file per surviving bucket.
   */
  test('every entry shares one id derived from the source', async () => {
    const files = await cached()
    const ids = new Set(files.map(f => f.split('-')[0]))

    expect(ids.size).toBe(1)
    expect(files.sort()).toEqual(
      [
        `${[...ids][0]}-16.webp`,
        `${[...ids][0]}-32.webp`,
        `${[...ids][0]}-${ImageHandler.maxImageSize}.webp`,
        `${[...ids][0]}-64.webp`,
        `${[...ids][0]}-main.webp`,
      ].sort(),
    )
  })
})
