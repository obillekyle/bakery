import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery } from '../../core/bakery'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '../../core/config'
import { getClientIp } from './ip'

// This file used to `mock.module` both core/config and core/bakery. Bun's
// module mocks are process-global and never restored, so it replaced
// core/bakery with `{ Bakery: { server } }` for every test file loaded
// afterwards — four tests in tests/multi-host.test.ts fail if the two run in
// that order. Both dependencies are real seams; use them.

const stubServer = { requestIP: () => ({ address: '127.0.0.1' }) }
let originalServer: typeof Bakery.server

beforeAll(async () => {
  await initConfig()
  originalServer = Bakery.server
  Bakery.server = stubServer as unknown as typeof Bakery.server
})

afterAll(() => {
  Bakery.server = originalServer
  __resetTestConfig()
})

describe('getClientIp', () => {
  test('extracts IP from x-forwarded-for when trustProxy', () => {
    __setTestConfig({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    })
    expect(getClientIp(req)).toBe('1.2.3.4')
  })

  test('extracts from x-real-ip', () => {
    __setTestConfig({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'x-real-ip': '9.8.7.6' },
    })
    expect(getClientIp(req)).toBe('9.8.7.6')
  })

  test('extracts from cf-connecting-ip', () => {
    __setTestConfig({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'cf-connecting-ip': '10.0.0.1' },
    })
    expect(getClientIp(req)).toBe('10.0.0.1')
  })

  test('returns fallback when trustProxy is false', () => {
    __setTestConfig({ trustProxy: false })
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    expect(getClientIp(req)).toBe('127.0.0.1')
  })

  test('returns empty string when no headers and no server', () => {
    __setTestConfig({ trustProxy: true })
    Bakery.server = undefined as unknown as typeof Bakery.server
    const req = new Request('http://localhost/')
    expect(getClientIp(req)).toBe('')
    Bakery.server = stubServer as unknown as typeof Bakery.server
  })
})
