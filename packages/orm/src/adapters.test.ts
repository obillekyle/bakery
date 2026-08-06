import { describe, test, expect } from 'bun:test'
import { createDbAdapter } from './adapters'

describe('createDbAdapter', () => {
  test('is a function', () => {
    expect(typeof createDbAdapter).toBe('function')
  })
})
