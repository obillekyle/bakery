import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetTestConfig,
  __setTestConfig,
  clearHostConfigCache,
  initConfig,
} from './core/config'
import { setLogCallback } from './logger/logger'
import { runStartupBanner } from './startup'
import { DEFAULT_RATE_LIMIT } from './utils/constants'

/**
 * The default rate limit (`{max: 100, refill: 10}`, per IP) is applied even
 * when the app never configured one, and used to be announced nowhere — it
 * silently 429'd load tests and shared-NAT offices. The banner line is its one
 * announcement. An app that set its *own* limit gets no line: their choice,
 * their knowledge — which is why the check is identity against the constant,
 * not deep equality.
 */

let lines: string[] = []

beforeEach(async () => {
  clearHostConfigCache()
  await initConfig()
  lines = []
  setLogCallback(entry => lines.push(entry.msg))
})

afterEach(() => {
  setLogCallback(() => {})
  __resetTestConfig()
  clearHostConfigCache()
})

const rateLimitLines = () => lines.filter(m => m.includes('Rate limit:'))

describe('runStartupBanner — default rate limit notice', () => {
  test('announces the default per-IP rate limit once', async () => {
    await runStartupBanner()

    const found = rateLimitLines()
    expect(found.length).toBe(1)
    expect(found[0]).toContain(String(DEFAULT_RATE_LIMIT.max))
    expect(found[0]).toContain(String(DEFAULT_RATE_LIMIT.refill))
    expect(found[0]).toContain('default')
    expect(found[0]).toContain('rateLimit: false')
  })

  test('says nothing when the app configured its own limit', async () => {
    // Same *values* as the default on purpose: an app that wrote these numbers
    // knows it has a rate limit, so identity — not equality — must decide.
    __setTestConfig({
      rateLimit: {
        max: DEFAULT_RATE_LIMIT.max,
        refill: DEFAULT_RATE_LIMIT.refill,
      },
    })

    await runStartupBanner()
    expect(rateLimitLines()).toEqual([])
  })

  test('says nothing when rate limiting is disabled', async () => {
    __setTestConfig({ rateLimit: false })

    await runStartupBanner()
    expect(rateLimitLines()).toEqual([])
  })
})
