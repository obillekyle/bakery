import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bakery } from '../core'
import { initConfig } from '../core/config'
import { ImageHandler } from '../handlers'
import { PublicHandler } from '../handlers/assets/public'

// Dirs the fixtures may create under cwd; only removed in afterAll if the
// suite created them and they end up empty.
const parentDirs = () => [join(Bakery.publicRoot, 'uploads'), Bakery.publicRoot]
const preExisting = new Set<string>()

beforeAll(async () => {
  for (const dir of parentDirs()) if (existsSync(dir)) preExisting.add(dir)
  await initConfig()
})

const testDir = 'uploads/_tests'
const created: string[] = []
const posix = (p: string) => p.replaceAll('\\', '/')

async function placeFile(rel: string, contents = 'hello') {
  const file = join(Bakery.publicRoot, testDir, rel)
  created.push(file)
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, contents)
  return file
}

afterAll(async () => {
  await rm(join(Bakery.publicRoot, testDir), { recursive: true, force: true })
  // uploads/ first, then public/ — inner must be gone for outer to be empty
  for (const dir of parentDirs()) {
    if (preExisting.has(dir) || !existsSync(dir)) continue
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  }
})

describe('PublicHandler', () => {
  test('serves existing file under /uploads/', async () => {
    await placeFile('pic.png')
    const res = await PublicHandler.handle(`/${testDir}/pic.png`)
    expect(res).toBeInstanceOf(Blob)
    expect(await new Response(res as Blob).text()).toBe('hello')
  })

  test('404s for missing files under /uploads/', async () => {
    const res = await PublicHandler.handle(`/${testDir}/nope.png`)
    // handle() returns BunFile | Response; only the Response arm has .status,
    // so assert which arm this is rather than casting past the distinction.
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })

  test('ignores paths outside /uploads/', () => {
    expect(PublicHandler.canHandle('/logo.png')).toBe(false)
    expect(PublicHandler.canHandle('/uploads/x.png')).toBe(true)
  })

  test('honors .forbidden marker', async () => {
    const secret = join(Bakery.publicRoot, testDir, 'forbid', 'secret.png')
    created.push(secret)
    await mkdir(join(secret, '..'), { recursive: true })
    await writeFile(secret, 'x')
    await writeFile(join(secret, '..', '.forbidden'), '')
    const res = await PublicHandler.handle(`/${testDir}/forbid/secret.png`)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(404)
  })
})

describe('ImageHandler publicRoot fallback', () => {
  test('resolves source from publicRoot when serveRoot misses', async () => {
    await placeFile('avatar.png')
    const parsed = await (ImageHandler as any).path(`/${testDir}/avatar.png`)
    expect(parsed.source).toBe(
      posix(join(Bakery.publicRoot, testDir, 'avatar.png')),
    )
  })

  test('keeps serveRoot source when file exists there', async () => {
    const srcFile = join(Bakery.serveRoot, testDir, 'logo.png')
    await mkdir(join(srcFile, '..'), { recursive: true })
    await writeFile(srcFile, 'x')
    created.push(srcFile)
    try {
      const parsed = await (ImageHandler as any).path(`/${testDir}/logo.png`)
      expect(parsed.source).toBe(posix(srcFile))
    } finally {
      await rm(join(Bakery.serveRoot, testDir), {
        recursive: true,
        force: true,
      })
    }
  })
})
