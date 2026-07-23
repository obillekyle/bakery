import { describe, test, expect, mock } from 'bun:test'

const mockGetConfig = mock(() => ({ trustProxy: true }))
mock.module('@server/core/config', () => ({
  getConfig: mockGetConfig,
}))

const mockServer = { requestIP: () => ({ address: '127.0.0.1' }) }
mock.module('@server/core/bakery', () => ({
  Bakery: { server: mockServer },
}))

import { getClientIp } from './ip'

describe('getClientIp', () => {
  test('extracts IP from x-forwarded-for when trustProxy', () => {
    mockGetConfig.mockReturnValue({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    })
    const ip = getClientIp(req)
    expect(ip).toBe('1.2.3.4')
  })

  test('extracts from x-real-ip', () => {
    mockGetConfig.mockReturnValue({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'x-real-ip': '9.8.7.6' },
    })
    const ip = getClientIp(req)
    expect(ip).toBe('9.8.7.6')
  })

  test('extracts from cf-connecting-ip', () => {
    mockGetConfig.mockReturnValue({ trustProxy: true })
    const req = new Request('http://localhost/', {
      headers: { 'cf-connecting-ip': '10.0.0.1' },
    })
    const ip = getClientIp(req)
    expect(ip).toBe('10.0.0.1')
  })

  test('returns fallback when trustProxy is false', () => {
    mockGetConfig.mockReturnValue({ trustProxy: false })
    const req = new Request('http://localhost/', {
      headers: { 'x-forwarded-for': '1.2.3.4' },
    })
    const ip = getClientIp(req)
    expect(ip).toBe('127.0.0.1')
  })

  test('returns empty string when no headers and no server', () => {
    mockGetConfig.mockReturnValue({ trustProxy: true })
    mockServer.requestIP = () => null as any
    const req = new Request('http://localhost/')
    const ip = getClientIp(req)
    expect(ip).toBe('')
    mockServer.requestIP = () => ({ address: '127.0.0.1' } as any)
  })
})
