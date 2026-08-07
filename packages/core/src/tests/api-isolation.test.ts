import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { fs } from '../utils/fs'
import { Bakery, hostStore } from '../core/bakery'
import { ApiHandler } from '../handlers/routes/api'
import { initConfig } from '../core/config'
import { executeAcrossEdit } from './fixtures'

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
    // The ambient (dev) flags, deliberately unwrapped. `handlers/routes/api.
    // test.ts` runs the identical fixture under `asProd` and expects `second`
    // to come back as `'first'`; the pair is what pins the cache-buster gate.
    const { dir, first, second } = await executeAcrossEdit('bakery-api-')
    directories.push(dir)

    expect(first).toBe('first')
    expect(second).toBe('second')
  })
})
