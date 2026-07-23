import { describe, expect, test, beforeAll } from 'bun:test'
import { fs } from '@server/utils/fs'
import { Bakery, hostStore } from '@server/core/bakery'
import { ApiHandler } from '@server/handlers/routes/api'
import { initConfig } from '@server/core/config'

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
