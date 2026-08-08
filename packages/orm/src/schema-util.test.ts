import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { MySQLAdapter } from './adapters/mysql'
import { PGAdapter } from './adapters/pgsql'
import { SQLiteAdapter } from './adapters/sqlite'
import { __resetTestDb, __setTestDb } from './connection'

const mockDb = { quoteChar: '"' }

// Use the connection test seam rather than `mock.module`: module mocks are
// process-global in Bun and leak into every later test file.
beforeAll(() => __setTestDb(mockDb))
afterAll(() => __resetTestDb())

import { evalOperands, isSafeIdentifier, SQLFunctionRef } from './schema-util'
import { Field } from './field'

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

describe('evalOperands SQL injection guards', () => {
  test('a plain object shaped like SQLFunctionRef is not treated as a function', () => {
    // The real exploit: a JSON request body reaching a `.where()` value.
    // `DELETE /api/admin/students` with {"id":{"fnName":"1 OR 1=1 OR ABS","col":"id"}}
    // used to emit `WHERE "id" = 1 OR 1=1 OR ABS("id")`.
    const params: any[] = []
    expect(() =>
      evalOperands({ fnName: '1 OR 1=1 OR ABS', col: 'id' }, params, false),
    ).toThrow()
    expect(params.join('')).not.toContain('1 OR 1=1')
  })

  test('a real SQLFunctionRef with an unknown function name is rejected', () => {
    const evil = new SQLFunctionRef('1 OR 1=1 OR ABS', 'id')
    expect(() => evalOperands(evil, [], false)).toThrow(/Unsupported SQL function/)
  })

  test('a real SQLFunctionRef with an allow-listed name still works', () => {
    const params: any[] = []
    const sql = evalOperands(new SQLFunctionRef('COUNT', 'id'), params, false)
    expect(sql).toBe('COUNT("id")')
  })

  test('function names are matched case-insensitively but emitted canonically', () => {
    expect(evalOperands(new SQLFunctionRef('count', 'id'), [], false)).toBe(
      'COUNT("id")',
    )
  })

  test('a bare object cannot inject a quote character into an identifier', () => {
    // `Case.snake` does not strip quote chars, so this used to break out of
    // the identifier and append arbitrary SQL.
    expect(() => evalOperands({ 'a" = "a': 'x' }, [], false)).toThrow(
      /Unsafe identifier/,
    )
    expect(() => evalOperands({ id: 'x" OR "1"="1' }, [], false)).toThrow(
      /Unsafe identifier/,
    )
  })

  test('a legitimate {table: column} reference still resolves', () => {
    expect(evalOperands({ users: 'id' }, [], false)).toBe('"users"."id"')
  })

  test('isSafeIdentifier rejects non-identifier input', () => {
    expect(isSafeIdentifier('users')).toBe(true)
    expect(isSafeIdentifier('_id1')).toBe(true)
    expect(isSafeIdentifier('1abc')).toBe(false)
    expect(isSafeIdentifier('a b')).toBe(false)
    expect(isSafeIdentifier('a"b')).toBe(false)
    expect(isSafeIdentifier(42)).toBe(false)
    expect(isSafeIdentifier(null)).toBe(false)
  })
})

describe('value', () => {
  test('creates type definition', () => {
    const def = Field.Text()
    expect(def.type).toBe('string')
  })

  test('includes default when provided', () => {
    const def = Field.Int(0)
    expect(def.default).toBe(0)
  })

  test('marks nullable', () => {
    expect(Field.Text(true).nullable).toBe(true)
    expect(Field.Int(null).nullable).toBe(true)
  })

  test('marks autoIncrement and primary together', () => {
    // Only `Field.Primary()` sets either, and it sets both. They were separate
    // positional booleans on the old `value()`, which is how a column could be
    // auto-increment without being a key — a shape no dialect wants.
    const def: any = Field.Primary()
    expect(def.autoIncrement).toBe(true)
    expect(def.primary).toBe(true)
  })
})

/**
 * A defaulted column is NOT NULL unless the default *is* null.
 *
 * This began as a regression guard for `value(type, default, false)`: the check
 * was `n !== undefined`, so *any* third argument made the column nullable,
 * including an explicit `false` that reads as the opposite. That spelling no
 * longer exists — `Field` has no positional booleans — so the bug is now
 * unreachable rather than merely fixed.
 *
 * The invariant it protected is still live and still worth pinning, because
 * `nullable` is what `colDef` reads to decide whether to emit `NOT NULL`: a
 * column declared not-null being created nullable is silent on every dialect.
 */
describe('a default does not make a column nullable', () => {
  const open: SQLiteAdapter[] = []
  afterAll(async () => {
    for (const db of open) await db.close()
  })

  function dialects() {
    const lite = new SQLiteAdapter(':memory:')
    open.push(lite)
    return [lite, new MySQLAdapter(), new PGAdapter()] as const
  }

  test('Field.Int(0) carries the default and no nullable flag', () => {
    const def = Field.Int(0)
    expect(def).toEqual({ type: 'integer', default: 0 } as typeof def)
    expect('nullable' in def).toBe(false)
  })

  test('the emitted DDL says NOT NULL on every dialect', () => {
    for (const db of dialects()) {
      expect(db.colDef(Field.Int(0))).toContain('NOT NULL')
    }
  })

  test('omitting the argument is still not nullable', () => {
    for (const db of dialects()) {
      expect(db.colDef(Field.Text())).toContain('NOT NULL')
    }
  })

  test('a null default makes it nullable', () => {
    expect(Field.Text(true).nullable).toBe(true)
    expect(Field.String(null).nullable).toBe(true)
    for (const db of dialects()) {
      expect(db.colDef(Field.Text(true))).not.toContain('NOT NULL')
      expect(db.colDef(Field.String(null))).not.toContain('NOT NULL')
    }
  })
})

describe('primary', () => {
  test('creates integer auto-increment primary key', () => {
    const def = Field.Primary()
    expect(def.type).toBe('integer')
    expect(def.autoIncrement).toBe(true)
    expect(def.primary).toBe(true)
  })

  test('carries no nullable flag', () => {
    // Harmless in practice — `colDef` and `diffColumnMismatch` both short-circuit
    // on `primary` — but it made the runtime value contradict the type, and it
    // was the same defect as above with a different argument.
    expect('nullable' in Field.Primary()).toBe(false)
  })
})

describe('index', () => {
  test('creates index definition', () => {
    const def = Field.Index('users', 'email')
    expect(def.table).toBe('users')
    expect(def.type).toBe('index')
    expect(def.cols).toEqual(['email'])
  })

  test('accepts array of columns', () => {
    const def = Field.Index('users', ['first_name', 'last_name'])
    expect(def.cols).toEqual(['first_name', 'last_name'])
  })
})

describe('unique', () => {
  test('creates unique constraint', () => {
    const def = Field.Unique('users', 'email')
    expect(def.table).toBe('users')
    expect(def.type).toBe('unique')
    expect(def.cols).toEqual(['email'])
  })

  test('accepts array of columns', () => {
    const def = Field.Unique('users', ['a', 'b'])
    expect(def.cols).toEqual(['a', 'b'])
  })
})
