import { describe, test, expect, beforeEach } from 'bun:test'
import { initConfig, clearHostConfigCache } from '@server/core/config'
import { PluginHooks } from './plugins'
import { Bakery } from './bakery'

beforeEach(async () => {
  clearHostConfigCache()
  await initConfig()
})

describe('PluginHooks', () => {
  test('setup runs without error with no plugins', async () => {
    await expect(PluginHooks.setup()).resolves.toBeUndefined()
  })

  test('onRequest returns null with no plugins', async () => {
    const req = new Request('http://localhost/')
    const result = await PluginHooks.onRequest(req)
    expect(result).toBeNull()
  })

  test('onRoute runs without error', async () => {
    const req = new Request('http://localhost/')
    await expect(PluginHooks.onRoute(req)).resolves.toBeUndefined()
  })

  test('onStart runs without error', async () => {
    await expect(PluginHooks.onStart(null)).resolves.toBeUndefined()
  })

  test('onError returns null with no plugins', async () => {
    const error = { errorCode: 500, errorText: 'Error', errorBody: 'test' }
    const result = await PluginHooks.onError(error)
    expect(result).toBeNull()
  })

  test('onShutdown runs without error', async () => {
    await expect(PluginHooks.onShutdown()).resolves.toBeUndefined()
  })

  test('onCompile returns content unchanged with no plugins', async () => {
    const content = 'const x = 1'
    const result = await PluginHooks.onCompile(content, 'test.ts')
    expect(result).toBe(content)
  })
})
