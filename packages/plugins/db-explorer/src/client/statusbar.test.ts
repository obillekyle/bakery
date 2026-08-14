import { describe, expect, test } from 'bun:test'
import { type StatusFacts, statusParts } from './statusbar'

const facts = (over: Partial<StatusFacts> = {}): StatusFacts => ({
  table: 'parcels',
  totalRows: 1204,
  page: 1,
  totalPages: 25,
  ms: 12,
  access: 'write',
  dirtyRows: 0,
  filterCount: 0,
  ...over,
})

describe('what the bar says', () => {
  test('the whole line, in order', () => {
    expect(statusParts(facts())).toEqual([
      '1,204 rows',
      'page 1 / 25',
      '12 ms',
      'read · write',
    ])
  })

  test('nothing open is an empty bar, not a row of placeholders', () => {
    expect(statusParts(facts({ table: null }))).toEqual([])
  })

  test('a six-figure count is separated so it can be read', () => {
    expect(statusParts(facts({ totalRows: 1234567 }))[0]).toBe('1,234,567 rows')
  })

  test('one row is singular', () => {
    expect(statusParts(facts({ totalRows: 1 }))[0]).toBe('1 row')
  })

  test('zero rows is plural, and is still reported', () => {
    expect(statusParts(facts({ totalRows: 0 }))[0]).toBe('0 rows')
  })

  test('an absent total is omitted rather than rendered as a question mark', () => {
    // `getData` genuinely does not always return one, and `page 1 / ?` teaches
    // nobody anything.
    const parts = statusParts(facts({ totalRows: undefined }))
    expect(parts[0]).toBe('page 1 / 25')
    expect(parts.join(' ')).not.toContain('rows')
  })

  test('an absent page total leaves the page number alone', () => {
    expect(statusParts(facts({ totalPages: undefined }))[1]).toBe('page 1')
  })

  test('applied filters are counted, so a surprising row count has a reason', () => {
    expect(statusParts(facts({ filterCount: 2 }))).toContain('2 filters')
    expect(statusParts(facts({ filterCount: 1 }))).toContain('1 filter')
  })

  test('no filters spends no segment', () => {
    expect(statusParts(facts()).join(' ')).not.toContain('filter')
  })
})

describe('the timing', () => {
  test('a sub-millisecond query keeps a decimal', () => {
    // Rounding a fast query to `0 ms` reads as "not measured", which is the
    // opposite of what it means.
    expect(statusParts(facts({ ms: 0.4 }))).toContain('0.4 ms')
  })

  test('a slow one is rounded', () => {
    expect(statusParts(facts({ ms: 1234.6 }))).toContain('1235 ms')
  })

  test('no timing means no segment', () => {
    // Structure and Relations render from the schema already in hand, so there
    // is nothing to report and nothing is invented.
    expect(statusParts(facts({ ms: null })).join(' ')).not.toContain('ms')
  })
})

describe('access and dirty rows', () => {
  test('a read session says so', () => {
    expect(statusParts(facts({ access: 'read' }))).toContain('read-only')
  })

  test('no access says so too rather than falling back to read', () => {
    expect(statusParts(facts({ access: false }))).toContain('no access')
  })

  test('unsaved rows are last, and only when there are any', () => {
    const parts = statusParts(facts({ dirtyRows: 3 }))
    expect(parts.at(-1)).toBe('3 unsaved rows')
    expect(statusParts(facts({ dirtyRows: 1 })).at(-1)).toBe('1 unsaved row')
    expect(statusParts(facts()).join(' ')).not.toContain('unsaved')
  })
})
