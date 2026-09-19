import { beforeEach, describe, expect, test } from 'bun:test'
import type { SchemaColumn } from './meta'
import {
  __resetBuildRecords,
  buildModel,
  buildRecords,
  type ImportModel,
  reassign,
  setBadRowPolicy,
  setEmptyToNull,
} from './csv-model'

/**
 * The import footer shows "N rows ready · M bad", and it recomputed that by
 * coercing every row of the file each time anything in the wizard changed —
 * including the bad-row policy dropdown sitting next to the number, which
 * cannot alter it. Measured at 153-250 ms per change on 50,000 rows of four
 * columns, on the main thread.
 *
 * Identity of the returned object is the assertion, because it is the one
 * observable difference between a reused result and an identical recomputed
 * one. `buildRecords` is pure, so two runs agree on every value.
 */
const COLUMNS: SchemaColumn[] = [
  { name: 'id', kind: 'number', nullable: false, hasDefault: true } as SchemaColumn,
  { name: 'courier', kind: 'string', nullable: false } as SchemaColumn,
  { name: 'note', kind: 'string', nullable: true } as SchemaColumn,
]

const CSV = ['id,courier,note', '1,dhl,first', '2,ups,second', '3,dhl,third'].join(
  '\n',
)

let model: ImportModel

beforeEach(() => {
  __resetBuildRecords()
  model = buildModel(CSV, COLUMNS)
})

describe('the footer does not recoerce the file for nothing', () => {
  test('the same model answers with the same object', () => {
    const first = buildRecords(model, COLUMNS)
    const second = buildRecords(model, COLUMNS)
    expect(second).toBe(first)
  })

  test('changing the bad-row policy reuses the build', () => {
    // The dropdown that sits in the same footer as the count it was redoing.
    // `onBadRow` decides what the *import* does with a bad row; it has no part
    // in deciding which rows are bad.
    const first = buildRecords(model, COLUMNS)
    const next = setBadRowPolicy(model, 'stop')
    expect(buildRecords(next, COLUMNS)).toBe(first)
  })

  test('changing the mapping does not reuse it', () => {
    const first = buildRecords(model, COLUMNS)
    const next = reassign(model, 'note', { kind: 'skip' })
    const second = buildRecords(next, COLUMNS)
    expect(second).not.toBe(first)
    // And the answer really did change, so the memo is not merely being
    // bypassed for an identical result.
    expect(Object.keys(second.records[0]!)).not.toContain('note')
  })

  test('changing an empty-to-null toggle does not reuse it', () => {
    const first = buildRecords(model, COLUMNS)
    const next = setEmptyToNull(model, 'note', true)
    expect(buildRecords(next, COLUMNS)).not.toBe(first)
  })

  test('a different column set does not reuse it', () => {
    // The same file mapped against another table is a different question.
    const first = buildRecords(model, COLUMNS)
    expect(buildRecords(model, [...COLUMNS])).not.toBe(first)
  })

  test('the reused result is the right one, not merely a fast one', () => {
    const first = buildRecords(model, COLUMNS)
    expect(first.records.length).toBe(3)
    expect(first.failures.length).toBe(0)
    expect(first.records[1]).toEqual({ id: 2, courier: 'ups', note: 'second' })

    const reused = buildRecords(setBadRowPolicy(model, 'all'), COLUMNS)
    expect(reused.records.length).toBe(3)
    expect(reused.records[1]).toEqual({ id: 2, courier: 'ups', note: 'second' })
  })
})
