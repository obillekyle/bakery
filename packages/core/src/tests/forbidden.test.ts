import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery, hostStore } from '../core/bakery'
import { getConfig, initConfig } from '../core/config'
import { getRoute } from '../handlers/core/$routing'
import { handleRequest } from '../router'
import { fs } from '../utils/fs'

describe('.forbidden Security Guard & Directory Protection', () => {
  const rootDir = fs.resolve(Bakery.root, 'src')
  const feetpicsDir = fs.resolve(rootDir, 'feetpics')
  const forbiddenFile = fs.resolve(feetpicsDir, '.forbidden')
  const testPage = fs.resolve(feetpicsDir, 'index.html')
  const subfolder = fs.resolve(feetpicsDir, 'subfolder')
  const subPage = fs.resolve(subfolder, 'secret.html')

  beforeAll(async () => {
    await initConfig()
    await fs.mkdir(feetpicsDir)
    await fs.mkdir(subfolder)
    await Bun.write(testPage, '<h1>Feetpics Index</h1>')
    await Bun.write(subPage, '<h1>Secret Subpage</h1>')
    await Bun.write(forbiddenFile, '') // empty .forbidden guard file
  })

  afterAll(async () => {
    await fs.rm(feetpicsDir, { recursive: true, force: true })
  })

  test('fs.isForbidden identifies directory and all its children as forbidden', () => {
    expect(fs.isForbidden(feetpicsDir, rootDir)).toBe(true)
    expect(fs.isForbidden(testPage, rootDir)).toBe(true)
    expect(fs.isForbidden(subfolder, rootDir)).toBe(true)
    expect(fs.isForbidden(subPage, rootDir)).toBe(true)
    expect(fs.isForbidden(fs.resolve(rootDir, 'blog'), rootDir)).toBe(false)
  })

  test('getRoute returns null for any route inside a forbidden folder', async () => {
    const routeTop = await getRoute('/feetpics', ['html'], rootDir, rootDir)
    expect(routeTop).toBeNull()

    const routeIndex = await getRoute(
      '/feetpics/index',
      ['html'],
      rootDir,
      rootDir,
    )
    expect(routeIndex).toBeNull()

    const routeSub = await getRoute(
      '/feetpics/subfolder/secret',
      ['html'],
      rootDir,
      rootDir,
    )
    expect(routeSub).toBeNull()
  })

  test('handleRequest immediately returns 403 Forbidden when requesting URLs in forbidden directories', async () => {
    await hostStore.run(
      { config: getConfig(), hostname: 'localhost' },
      async () => {
        const res1 = await handleRequest(
          new Request('http://localhost:6767/feetpics'),
        )
        expect(res1 instanceof Response).toBe(true)
        if (res1 instanceof Response) {
          expect(res1.status).toBe(403)
        }

        const res2 = await handleRequest(
          new Request('http://localhost:6767/feetpics/index'),
        )
        expect(res2 instanceof Response).toBe(true)
        if (res2 instanceof Response) {
          expect(res2.status).toBe(403)
        }

        const res3 = await handleRequest(
          new Request('http://localhost:6767/feetpics/subfolder/secret.html'),
        )
        expect(res3 instanceof Response).toBe(true)
        if (res3 instanceof Response) {
          expect(res3.status).toBe(403)
        }
      },
    )
  })
})
