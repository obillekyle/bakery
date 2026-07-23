import { describe, test, expect, mock } from 'bun:test'

const mockDb = { quoteChar: '"' }
mock.module('./connection', () => ({
  getActiveDb: () => mockDb,
}))

import { evalOperands, value, primary, index, unique } from './schema-util'

describe('evalOperands', () => {
  test('pushes scalar values as params', () => {
    const params: any[] = []
    const result = evalOperands(42, params)
    expect(result).toBe('?')
    expect(params).toEqual([42])
  })

  test('handles null', () => {
    const params: any[] = []
    const result = evalOperands(null, params)
    expect(result).toBe('NULL')
    expect(params).toEqual([])
  })

  test('handles boolean', () => {
    const params: any[] = []
    expect(evalOperands(true, params)).toBe('TRUE')
    expect(evalOperands(false, params)).toBe('FALSE')
  })

  test('handles table.column string', () => {
    const params: any[] = []
    const result = evalOperands('users.id', params)
    expect(result).toContain('users')
    expect(result).toContain('id')
    expect(params).toEqual([])
  })

  test('handles SQL function objects', () => {
    const params: any[] = []
    const result = evalOperands({ UPPER: { col: 'name' } }, params)
    expect(result).toContain('UPPER')
  })

  test('handles arrays', () => {
    const params: any[] = []
    const result = evalOperands([1, 2, 3], params)
    expect(result).toContain('(')
    expect(result).toContain(')')
    expect(params).toEqual([1, 2, 3])
  })

  test('throws on empty object', () => {
    expect(() => evalOperands({}, [])).toThrow()
  })
})

describe('value', () => {
  test('creates type definition', () => {
    const def = value('string')
    expect(def.type).toBe('string')
  })

  test('includes default when provided', () => {
    const def = value('integer', 0)
    expect(def.default).toBe(0)
  })

  test('marks nullable', () => {
    const def = value('string', undefined, true)
    expect(def.nullable).toBe(true)
  })

  test('marks autoIncrement', () => {
    const def = value('integer', undefined, false, true)
    expect(def.autoIncrement).toBe(true)
  })

  test('marks primary', () => {
    const def = value('integer', undefined, false, false, true)
    expect(def.primary).toBe(true)
  })
})

describe('primary', () => {
  test('creates integer auto-increment primary key', () => {
    const def = primary()
    expect(def.type).toBe('integer')
    expect(def.autoIncrement).toBe(true)
    expect(def.primary).toBe(true)
  })
})

describe('index', () => {
  test('creates index definition', () => {
    const def = index('users', 'email')
    expect(def.table).toBe('users')
    expect(def.type).toBe('index')
    expect(def.cols).toEqual(['email'])
  })

  test('accepts array of columns', () => {
    const def = index('users', ['first_name', 'last_name'])
    expect(def.cols).toEqual(['first_name', 'last_name'])
  })
})

describe('unique', () => {
  test('creates unique constraint', () => {
    const def = unique('users', 'email')
    expect(def.table).toBe('users')
    expect(def.type).toBe('unique')
    expect(def.cols).toEqual(['email'])
  })

  test('accepts array of columns', () => {
    const def = unique('users', ['a', 'b'])
    expect(def.cols).toEqual(['a', 'b'])
  })
})
