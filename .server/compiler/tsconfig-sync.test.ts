import { describe, test, expect, beforeEach } from 'bun:test'
import { syncTSConfigPaths } from './tsconfig-sync'
import { initConfig, clearHostConfigCache } from '@server/core/config'

beforeEach(async () => {
  clearHostConfigCache()
  await initConfig()
})

describe('syncTSConfigPaths', () => {
  test('runs without error', async () => {
    await expect(syncTSConfigPaths()).resolves.toBeUndefined()
  })

  test('is idempotent (no-op on second call)', async () => {
    await syncTSConfigPaths()
    await expect(syncTSConfigPaths()).resolves.toBeUndefined()
  })
})
