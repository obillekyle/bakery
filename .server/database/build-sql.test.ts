import { describe, test, expect, mock, beforeAll } from 'bun:test'

const mockDb = { quoteChar: '"' }
mock.module('./connection', () => ({
  getActiveDb: () => mockDb,
  initDB: async () => {},
}))

import { buildSQL } from './build-sql'
import { DB } from './query'

describe('QBRaw', () => {
  test('parse returns raw sql and params', () => {
    const raw = new DB.QBRaw('SELECT * FROM users WHERE id = ?', [42])
    const { sql, params } = raw.parse()
    expect(sql).toBe('SELECT * FROM users WHERE id = ?')
    expect(params).toEqual([42])
  })
})

describe('buildSQL', () => {
  test('builds simple SELECT * FROM table', () => {
    const qb = DB.table('users')
    const { sql } = buildSQL(qb as any)
    expect(sql).toContain('SELECT')
    expect(sql).toContain('FROM')
    expect(sql).toContain('users')
  })

  test('builds SELECT with specific columns', () => {
    const qb = DB.table('users').select({ id: 'id', name: 'name' })
    const { sql } = buildSQL(qb as any)
    expect(sql).toContain('id')
    expect(sql).toContain('name')
  })

  test('builds WHERE clause', () => {
    const qb = DB.table('users').where('id', '=', 42)
    const { sql, params } = buildSQL(qb as any)
    expect(sql).toContain('WHERE')
    expect(params).toContain(42)
  })

  test('builds ORDER BY', () => {
    const qb = DB.table('users').selectAll('users').orderBy('id', 'DESC')
    const { sql } = buildSQL(qb as any)
    expect(sql).toContain('ORDER BY')
    expect(sql).toContain('DESC')
  })

  test('builds LIMIT', () => {
    const qb = DB.table('users').selectAll('users').limit(10, 5)
    const { sql } = buildSQL(qb as any)
    expect(sql).toContain('LIMIT 10')
    expect(sql).toContain('OFFSET 5')
  })
})
