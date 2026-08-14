import { describe, expect, test } from 'bun:test'
import type { ColumnMeta } from './coerce'
import { autoMap, blockingIssues, type PlanColumn, updatePlan } from './plan'

const column = (name: string, over: Partial<ColumnMeta> = {}): PlanColumn => ({
  name,
  meta: { kind: 'string', nullable: false, hasDefault: false, ...over },
})

describe('autoMap', () => {
  test('exact names, then case- and separator-insensitive ones', () => {
    expect(
      autoMap(
        ['id', 'Courier Name', 'weightKg'],
        ['id', 'courier_name', 'weight_kg'],
      ),
    ).toEqual({
      id: 'id',
      'Courier Name': 'courier_name',
      weightKg: 'weight_kg',
    })
  })

  test('an unmatched header maps to nothing rather than to something close', () => {
    expect(autoMap(['courier_id'], ['courier'])).toEqual({ courier_id: null })
  })

  test('a database column is claimed once, so a second header does not steal it', () => {
    expect(autoMap(['name', 'Name'], ['name'])).toEqual({
      name: 'name',
      Name: null,
    })
  })
})

describe('blockingIssues', () => {
  const columns = [
    column('id', { autoIncrement: true, primary: true }),
    column('courier'),
    column('note', { nullable: true }),
    column('created', { hasDefault: true }),
  ]

  test('an unmapped NOT NULL column with no default blocks the import', () => {
    const issues = blockingIssues({ id: 'id' }, columns)
    expect(issues.map(i => `${i.code}:${i.column}`)).toEqual([
      'required_unmapped:courier',
    ])
  })

  test('auto-increment, defaulted and nullable columns may be left out', () => {
    expect(blockingIssues({ c: 'courier' }, columns)).toEqual([])
  })

  test('a header mapped to a column that does not exist is named', () => {
    const issues = blockingIssues({ c: 'courier', x: 'nope' }, columns)
    expect(issues.map(i => i.code)).toContain('unknown_column')
  })

  test('two headers on one column is an issue, not a silent last-wins', () => {
    const issues = blockingIssues({ a: 'courier', b: 'courier' }, columns)
    expect(issues.map(i => i.code)).toContain('duplicate_target')
  })
})

describe('updatePlan', () => {
  const original = { id: 7, courier: 'dhl', weight: 2.5, paid: 1 }

  test('where comes from the original row, so a key may itself be edited', () => {
    const plan = updatePlan({
      original,
      edits: { id: 8 },
      identity: ['id'],
    })
    expect(plan.set).toEqual({ id: 8 })
    // The old value, not the new one — an UPDATE keyed on the edited value
    // would look for a row that does not exist yet.
    expect(plan.where).toEqual({ id: 7 })
  })

  test('unchanged edits are dropped from set', () => {
    const plan = updatePlan({
      original,
      edits: { courier: 'dhl', weight: 3 },
      identity: ['id'],
    })
    expect(plan.set).toEqual({ weight: 3 })
    expect(plan.unchanged).toEqual(['courier'])
  })

  test('a value the driver typed differently is not a change', () => {
    // `paid` comes back as 1 from SQLite; the browser sends `true`.
    const plan = updatePlan({
      original,
      edits: { paid: true, weight: '2.5' },
      identity: ['id'],
    })
    expect(plan.set).toEqual({})
    expect(plan.unchanged.sort()).toEqual(['paid', 'weight'])
  })

  test('a composite identity is carried whole', () => {
    const plan = updatePlan({
      original: { a: 1, b: 2, v: 'x' },
      edits: { v: 'y' },
      identity: ['a', 'b'],
    })
    expect(plan.where).toEqual({ a: 1, b: 2 })
    expect(plan.missingIdentity).toEqual([])
  })

  test('an identity column the row does not carry is reported, not guessed', () => {
    const plan = updatePlan({
      original: { v: 'x' },
      edits: { v: 'y' },
      identity: ['a', 'b'],
    })
    expect(plan.missingIdentity).toEqual(['a', 'b'])
    expect(plan.where).toEqual({})
  })
})
