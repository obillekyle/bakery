import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_DB_BACKUPS,
  DEFAULT_SESSION_TTL,
  DEFAULT_SESSION_PERSIST,
  DEFAULT_RATE_LIMIT,
  DEFAULT_BLOCKED_GLOBS,
} from './constants'

describe('constants', () => {
  test('DEFAULT_PORT is 3000', () => {
    expect(DEFAULT_PORT).toBe(3000)
  })

  test('DEFAULT_HOST is 0.0.0.0', () => {
    expect(DEFAULT_HOST).toBe('0.0.0.0')
  })

  test('DEFAULT_DB_BACKUPS is 10', () => {
    expect(DEFAULT_DB_BACKUPS).toBe(10)
  })

  test('DEFAULT_SESSION_TTL is 24h in ms', () => {
    expect(DEFAULT_SESSION_TTL).toBe(1000 * 60 * 60 * 24)
  })

  test('DEFAULT_SESSION_PERSIST is 30x TTL', () => {
    expect(DEFAULT_SESSION_PERSIST).toBe(DEFAULT_SESSION_TTL * 30)
  })

  test('DEFAULT_RATE_LIMIT has max and refill', () => {
    expect(DEFAULT_RATE_LIMIT.max).toBe(100)
    expect(DEFAULT_RATE_LIMIT.refill).toBe(10)
  })

  test('DEFAULT_BLOCKED_GLOBS includes sensitive files', () => {
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/.env')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/*.db')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/.server/**')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/node_modules/**')
    expect(DEFAULT_BLOCKED_GLOBS).toContain('**/schema.ts')
  })
})
