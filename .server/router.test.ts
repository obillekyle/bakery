import { describe, test, expect, beforeAll } from 'bun:test'
import { initConfig, getConfig } from '@server/core/config'
import { handleRequest, processResponse } from './router'
import { hostStore } from '@server/core/bakery'

beforeAll(async () => {
  await initConfig()
})

describe('handleRequest', () => {
  test('returns 403 for blocked paths', async () => {
    await hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
      const res = await handleRequest(new Request('http://localhost:3000/.env'))
      expect(res).toBeInstanceOf(Response)
      expect((res as Response).status).toBe(403)
    })
  })

  test('returns Response for routes', async () => {
    await hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
      const res = await handleRequest(new Request('http://localhost:3000/nonexistent-page-xyz'))
      expect(res !== undefined).toBe(true)
    })
  })

  test('returns Response for forbidden paths', async () => {
    await hostStore.run({ config: getConfig(), hostname: 'localhost' }, async () => {
      const res = await handleRequest(new Request('http://localhost:3000/feetpics'))
      expect(res !== undefined).toBe(true)
    })
  })
})

describe('processResponse', () => {
  test('returns 204 Response for null', async () => {
    const req = new Request('http://localhost/')
    ;(req as any).startNs = Bun.nanoseconds()
    const res = await processResponse(null as any, req)
    expect(res).toBeInstanceOf(Response)
    expect((res as Response).status).toBe(204)
  })

  test('processes string response', async () => {
    const req = new Request('http://localhost/')
    ;(req as any).startNs = Bun.nanoseconds()
    const res = await processResponse('hello', req)
    expect(res).toBeInstanceOf(Response)
  })
})
