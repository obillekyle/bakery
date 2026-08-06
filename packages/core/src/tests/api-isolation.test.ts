import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fs } from '../utils/fs'
import { Bakery, hostStore } from '../core/bakery'
import { ApiHandler } from '../handlers/routes/api'
import { initConfig } from '../core/config'

describe('Virtual Host API Isolation (`Bakery.serveRoot + /api`)', () => {
  beforeAll(async () => {
    await initConfig()
  })

  test('Bakery.apiRoot and ApiHandler.config.dir automatically resolve to serveRoot + /api for default host', () => {
    const expectedApiRoot = fs.resolve(Bakery.serveRoot, 'api')
    expect(Bakery.apiRoot).toBe(expectedApiRoot)
    expect(ApiHandler.config.dir).toBe(expectedApiRoot)
  })

  test('Bakery.apiRoot automatically isolates to serveRoot + /api when virtual host changes serveRoot', async () => {
    const baseConfig = await initConfig()
    const customHostRoot = fs.resolve(Bakery.root, 'sites/paldo/src')
    const customHostConfig = {
      ...baseConfig,
      root: customHostRoot,
    } as any

    await hostStore.run(
      { config: customHostConfig, hostname: 'paldo.dev' },
      async () => {
        const expectedApiRoot = fs.resolve(customHostRoot, 'api')
        expect(Bakery.serveRoot).toBe(customHostRoot)
        expect(Bakery.apiRoot).toBe(expectedApiRoot)
        expect(ApiHandler.config.dir).toBe(expectedApiRoot)
      },
    )
  })
})

describe('API module reloads', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true })))
  })

  test('reloads an API module when its modification time changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bakery-api-'))
    directories.push(dir)
    const file = join(dir, 'handler.ts')
    const req = new Request('http://localhost/api/test')

    await writeFile(file, "export default () => 'first'")
    expect(await ApiHandler.executeModule(file as any, req, null)).toBe('first')

    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(file, "export default () => 'second'")
    expect(await ApiHandler.executeModule(file as any, req, null)).toBe('second')
  })
})
