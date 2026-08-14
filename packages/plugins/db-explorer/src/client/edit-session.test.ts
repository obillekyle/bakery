import { describe, expect, test } from 'bun:test'
import type { ColumnKind } from '../shared/coerce'
import { EditSession, rowId, UndoStack } from './edit-session'

const KINDS: Record<string, ColumnKind> = {
  id: 'integer',
  courier: 'string',
  paid: 'boolean',
  meta: 'json',
}
const kindOf = (column: string) => KINDS[column]

const row = { id: 7, courier: 'dhl', paid: 1, meta: '{"a":1}' }

describe('rowId', () => {
  test('a composite identity is one stable string in declared order', () => {
    expect(rowId({ a: 1, b: 2 }, ['a', 'b'])).toBe('[1,2]')
    // Declared order, not object order — the server sends `identity.cols`.
    expect(rowId({ b: 2, a: 1 }, ['a', 'b'])).toBe('[1,2]')
  })

  test('a row missing an identity column cannot be addressed at all', () => {
    expect(rowId({ a: 1 }, ['a', 'b'])).toBeNull()
    expect(rowId({ a: 1 }, [])).toBeNull()
  })
})

describe('staging', () => {
  test('a changed value is staged and shown in place of the original', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    expect(session.value('r', 'courier', 'dhl')).toBe('ups')
    expect(session.isStaged('r', 'courier')).toBe(true)
    expect(session.dirtyRows()).toBe(1)
  })

  test('typing a change and typing it back leaves the row clean', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    session.stage('r', row, 'courier', 'dhl')
    expect(session.isDirty('r')).toBe(false)
    expect(session.dirtyRows()).toBe(0)
  })

  test('a value the driver merely typed differently is not an edit', () => {
    // SQLite hands a boolean back as 1 and the checkbox reads back `true`.
    // Strict equality here would make every boolean cell dirty on open.
    const session = new EditSession()
    session.stage('r', row, 'paid', true)
    expect(session.isDirty('r')).toBe(false)
  })

  test('revert drops the row entirely, original included', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    session.drop('r')
    expect(session.original('r')).toBeUndefined()
    expect(session.value('r', 'courier', 'dhl')).toBe('dhl')
  })
})

describe('plan', () => {
  test('one row, one statement, carrying every changed column', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    session.stage('r', row, 'paid', false)
    const plan = session.plan('r', ['id'], kindOf)!

    expect(plan.set).toEqual({ courier: 'ups', paid: false })
    expect(plan.where).toEqual({ id: 7 })
    expect(plan.missingIdentity).toEqual([])
  })

  test('expect is the pre-image of the changed columns, and only those', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    const plan = session.plan('r', ['id'], kindOf)!
    // Not the whole row: a wide `expect` collides with anyone editing any
    // other column of the same row.
    expect(plan.expect).toEqual({ courier: 'dhl' })
  })

  test('the identity predicate comes from the pre-image, so a key can be edited', () => {
    const session = new EditSession()
    session.stage('r', row, 'id', 8)
    const plan = session.plan('r', ['id'], kindOf)!
    expect(plan.set).toEqual({ id: 8 })
    // The old value — an UPDATE keyed on 8 would find no row.
    expect(plan.where).toEqual({ id: 7 })
  })

  test('a json column is reported unguardable rather than put in expect', () => {
    // Postgres has no `=` for `json` and MySQL compares it structurally, so an
    // `expect` on one is a predicate that never matches: every edit a 409.
    const session = new EditSession()
    session.stage('r', row, 'meta', '{"a":2}')
    const plan = session.plan('r', ['id'], kindOf)!
    expect(plan.unguardable).toEqual(['meta'])
    expect(plan.expect).toEqual({})
  })

  test('a column of unknown kind is guarded rather than silently skipped', () => {
    const session = new EditSession()
    session.stage('r', row, 'courier', 'ups')
    const plan = session.plan('r', ['id'], () => undefined)!
    expect(plan.unguardable).toEqual([])
    expect(plan.expect).toEqual({ courier: 'dhl' })
  })

  test('a missing identity column is named, not guessed', () => {
    const session = new EditSession()
    session.stage('r', { courier: 'dhl' }, 'courier', 'ups')
    const plan = session.plan('r', ['id'], kindOf)!
    expect(plan.missingIdentity).toEqual(['id'])
    expect(plan.where).toEqual({})
  })

  test('a clean row has no plan', () => {
    expect(new EditSession().plan('r', ['id'], kindOf)).toBeNull()
  })
})

describe('UndoStack', () => {
  const entry = (label: string) => ({ label, undo: async () => {} })

  test('newest first, and bounded at twenty', () => {
    const stack = new UndoStack(20)
    for (let i = 0; i < 25; i++) stack.push(entry(`e${i}`))
    expect(stack.size).toBe(20)
    expect(stack.peek()?.label).toBe('e24')
  })

  test('pop returns the newest and shrinks the stack', () => {
    const stack = new UndoStack(3)
    stack.push(entry('a'))
    stack.push(entry('b'))
    expect(stack.pop()?.label).toBe('b')
    expect(stack.size).toBe(1)
  })
})
