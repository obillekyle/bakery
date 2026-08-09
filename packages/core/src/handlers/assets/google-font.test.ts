import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { COMPRESSION_MAP, fs } from '../../utils/fs'
import {
  __gfCacheIndex,
  __gfMaxEntries,
  __gfTrackCacheEntry,
  GoogleFontHandler,
} from './google-font'

/**
 * This handler is an unauthenticated outbound fetch from the server's own IP,
 * with a cache key built from an attacker-controlled path and query. Google
 * answers 200 for parameters it does not recognise, so before the allow-lists
 * every junk request minted a fresh cache key and a fresh upstream request --
 * six junk requests were measured producing six keys and eighteen files.
 *
 * Every assertion below is on a *rejection*, which is the half that never
 * reaches the network. Nothing here talks to Google.
 */
const request = (path: string, query = '') =>
  new Request(`http://localhost:3000${path}${query}`)

const statusOf = async (path: string, query = '') => {
  const res = await GoogleFontHandler.handle(`${path}`, request(path, query))
  return res instanceof Response ? res.status : 0
}

describe('GoogleFontHandler - the CSS endpoint is allow-listed', () => {
  test('refuses a path that is not a Google Fonts CSS endpoint', async () => {
    for (const path of [
      '/_gf/evil',
      '/_gf/oauth2/v1/token',
      '/_gf/css3',
      '/_gf/../../admin',
    ]) {
      expect(await statusOf(path, '?family=Roboto')).toBe(404)
    }
  })

  test('refuses an undocumented query parameter', async () => {
    // The amplifier: Google returns 200 for these, so each one was a new cache
    // entry and a new outbound request.
    for (const query of [
      '?family=Roboto&junk=1',
      '?cachebust=99',
      '?family=Roboto&x',
      '?FAMILY=Roboto',
    ]) {
      expect(await statusOf('/_gf/css2', query)).toBe(400)
    }
  })

  test('refuses a query with too many parameters or too long a value', async () => {
    const many = Array.from({ length: 40 }, () => 'family=Roboto').join('&')
    expect(await statusOf('/_gf/css2', `?${many}`)).toBe(400)

    const long = `?family=${'a'.repeat(600)}`
    expect(await statusOf('/_gf/css2', long)).toBe(400)
  })
})

describe('GoogleFontHandler - the gstatic proxy is allow-listed', () => {
  test('refuses anything that is not a font payload path', async () => {
    for (const path of [
      '/_gf/gstatic/../../../etc/passwd',
      '/_gf/gstatic/s/roboto/../../../secret.woff2',
      '/_gf/gstatic//evil.woff2',
      '/_gf/gstatic/s/roboto/v47/font.js',
      '/_gf/gstatic/s/roboto/v47/font',
      '/_gf/gstatic/.env',
    ]) {
      expect(await statusOf(path)).toBe(404)
    }
  })

  test('refuses an over-long path', async () => {
    const deep = `s/${'a/'.repeat(200)}font.woff2`
    expect(await statusOf(`/_gf/gstatic/${deep}`)).toBe(404)
  })
})

/**
 * The bound. Reaching eviction through `handle()` legitimately would mean 257
 * successful round trips to Google, so this drives the index through the
 * documented `__gf*` seams instead -- the same shape as `__setTestConfig`.
 */
describe('GoogleFontHandler - the cache is bounded', () => {
  const dir = fs.resolve(
    process.cwd(),
    '.cache',
    `gf-bound-test-${Bun.randomUUIDv7()}`,
  )

  const filesFor = (name: string) => [
    fs.resolve(dir, name),
    ...COMPRESSION_MAP.map(({ ext }) => `${fs.resolve(dir, name)}${ext}`),
  ]

  beforeAll(async () => {
    await fs.mkdir(dir)
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  test('the bound is a small number, not a large one', () => {
    // Without this the test below is unfalsifiable: it derives its loop count
    // from the very constant it is policing, so raising GF_MAX_ENTRIES to a
    // hundred thousand would raise the loop with it and still pass. Verified:
    // that planted change went green until this assertion existed.
    expect(__gfMaxEntries).toBeGreaterThan(0)
    expect(__gfMaxEntries).toBeLessThanOrEqual(1024)
  })

  test('the index never exceeds its bound, and eviction takes the files', async () => {
    const first = 'entry-0.css'

    // One entry's worth of what getOrCreateCachedFile writes: raw, .zst, .gz.
    for (const file of filesFor(first)) await Bun.write(file, 'x')
    expect(filesFor(first).every(f => fs.exists(f))).toBe(true)

    __gfTrackCacheEntry(dir, first)

    // Enough distinct keys to push the first one out.
    for (let i = 1; i <= __gfMaxEntries; i++) {
      __gfTrackCacheEntry(dir, `entry-${i}.css`)
    }

    expect(__gfCacheIndex.size).toBeLessThanOrEqual(__gfMaxEntries)
    expect(__gfCacheIndex.has(fs.resolve(dir, first))).toBe(false)

    // onEvict is fire-and-forget; give the unlinks a turn of the loop.
    await Bun.sleep(50)
    expect(filesFor(first).filter(f => fs.exists(f))).toEqual([])
  })
})
