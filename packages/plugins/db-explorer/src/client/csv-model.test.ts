import { describe, expect, test } from 'bun:test'
import {
  buildModel,
  buildRecords,
  chunk,
  issuesOf,
  looksLikeHeader,
  mappingOf,
  previewRows,
  reassign,
  rejectedCSV,
  setBadRowPolicy,
  setEmptyToNull,
  targetOf,
  writeCSV,
} from './csv-model'
import type { SchemaColumn } from './meta'

const column = (over: Partial<SchemaColumn> = {}): SchemaColumn => ({
  name: 'value',
  type: 'TEXT',
  notnull: true,
  pk: false,
  kind: 'string',
  nullable: false,
  hasDefault: false,
  ...over,
})

const COLUMNS: SchemaColumn[] = [
  column({
    name: 'id',
    kind: 'integer',
    type: 'INTEGER',
    pk: true,
    autoIncrement: true,
  }),
  column({ name: 'courier' }),
  column({
    name: 'weight_kg',
    kind: 'number',
    type: 'REAL',
    nullable: true,
    notnull: false,
  }),
  column({ name: 'note', nullable: true, notnull: false }),
]

const FILE = 'id,Courier,weightKg\n1,dhl,2.5\n2,ups,3\n'

describe('header detection', () => {
  test('non-empty, unique and non-numeric reads as a header', () => {
    expect(
      looksLikeHeader([
        ['id', 'courier'],
        ['1', 'dhl'],
      ]),
    ).toBe(true)
  })

  test('a numeric first row is data', () => {
    expect(
      looksLikeHeader([
        ['1', 'dhl'],
        ['2', 'ups'],
      ]),
    ).toBe(false)
  })

  test('a duplicated or blank first row is data', () => {
    expect(looksLikeHeader([['a', 'a']])).toBe(false)
    expect(looksLikeHeader([['a', '']])).toBe(false)
  })
})

describe('buildModel', () => {
  test('the delimiter is sniffed and the mapping is guessed', () => {
    const model = buildModel(FILE, COLUMNS)
    expect(model.delimiter).toBe(',')
    expect(model.rows.length).toBe(2)
    expect(mappingOf(model)).toEqual({
      id: 'id',
      Courier: 'courier',
      weightKg: 'weight_kg',
    })
  })

  test('a semicolon file is not read as one column', () => {
    const model = buildModel('id;courier\n1;dhl\n', COLUMNS)
    expect(model.delimiter).toBe(';')
    expect(model.headers).toEqual(['id', 'courier'])
  })

  test('empty → NULL defaults on for every kind except text', () => {
    // `''` is a value in a text column and an error in every other one.
    const model = buildModel(FILE, COLUMNS)
    expect(model.emptyToNull.id).toBe(true)
    expect(model.emptyToNull.weight_kg).toBe(true)
    expect(model.emptyToNull.courier).toBe(false)
  })

  test('with no header row the columns are synthesised and no row is lost', () => {
    const model = buildModel('1,dhl\n2,ups\n', COLUMNS, { hasHeader: false })
    expect(model.headers).toEqual(['Column 1', 'Column 2'])
    expect(model.rows.length).toBe(2)
  })

  test('a ragged row is squared off and counted rather than refusing the file', () => {
    const model = buildModel('a,b,c\n1,2\n', COLUMNS)
    expect(model.rows[0]).toEqual(['1', '2', ''])
    expect(model.ragged).toEqual([{ row: 1, fields: 2 }])
  })
})

describe('reassign moves a target rather than duplicating it', () => {
  test('re-picking a claimed column drops the previous holder to skip', () => {
    const model = buildModel(FILE, COLUMNS)
    const next = reassign(model, 'weightKg', {
      kind: 'column',
      column: 'courier',
    })
    expect(targetOf(next.assign.weightKg!)).toBe('courier')
    // The header that used to own `courier` falls to skip — a duplicate
    // mapping is therefore impossible to express, not merely discouraged.
    expect(targetOf(next.assign.Courier!)).toBeNull()
  })

  test('skip clears only the header it names', () => {
    const model = buildModel(FILE, COLUMNS)
    const next = reassign(model, 'id', { kind: 'skip' })
    expect(targetOf(next.assign.id!)).toBeNull()
    expect(targetOf(next.assign.Courier!)).toBe('courier')
  })

  test('a constant claims its column the same way a mapping does', () => {
    const model = buildModel(FILE, COLUMNS)
    const next = reassign(model, 'weightKg', {
      kind: 'constant',
      column: 'courier',
      text: 'fedex',
    })
    expect(targetOf(next.assign.Courier!)).toBeNull()
    expect(mappingOf(next).weightKg).toBe('courier')
  })
})

describe('blocking issues', () => {
  test('an unmapped NOT NULL column with no default blocks and names itself', () => {
    const model = buildModel('id\n1\n', COLUMNS)
    const issues = issuesOf(model, COLUMNS)
    expect(issues.blocking.map(i => `${i.code}:${i.column}`)).toEqual([
      'required_unmapped:courier',
    ])
  })

  test('a constant satisfies a required column', () => {
    const model = reassign(buildModel('id\n1\n', COLUMNS), 'id', {
      kind: 'constant',
      column: 'courier',
      text: 'dhl',
    })
    expect(issuesOf(model, COLUMNS).blocking).toEqual([])
  })

  test('auto-increment, defaulted and nullable columns are tagged, not blocking', () => {
    const issues = issuesOf(buildModel(FILE, COLUMNS), COLUMNS)
    expect(issues.blocking).toEqual([])
    expect(issues.unmapped).toEqual([{ column: 'note', status: 'nullable' }])
  })

  test('a CSV column going nowhere is counted and named, not an error', () => {
    const model = buildModel('id,courier,extra\n1,dhl,x\n', COLUMNS)
    expect(issuesOf(model, COLUMNS).unmatched).toEqual(['extra'])
  })
})

describe('preview', () => {
  test('a coerced value that differs from the text is visible as both', () => {
    const rows = previewRows(buildModel(FILE, COLUMNS), COLUMNS, 10)
    const id = rows[0]!.cells.find(c => c.column === 'id')!
    expect(id.ok).toBe(true)
    expect(id.value).toBe(1)
    expect(id.raw).toBe('1')
  })

  test('a failure carries the reason coerceValue gave', () => {
    const model = buildModel('id,Courier\nabc,dhl\n', COLUMNS)
    const cell = previewRows(model, COLUMNS, 10)[0]!.cells.find(
      c => c.column === 'id',
    )!
    expect(cell.ok).toBe(false)
    expect(cell.message).toContain('whole number')
  })

  test('empty → NULL is applied before coercion, or it would never be reached', () => {
    // `coerceValue` refuses `''` on every non-text kind, so a toggle applied
    // afterwards is a toggle that does nothing.
    const model = buildModel('id,Courier,weightKg\n1,dhl,\n', COLUMNS)
    const on = previewRows(model, COLUMNS, 1)[0]!.cells.find(
      c => c.column === 'weight_kg',
    )!
    expect(on.ok).toBe(true)
    expect(on.value).toBeNull()

    const off = previewRows(
      setEmptyToNull(model, 'weight_kg', false),
      COLUMNS,
      1,
    )[0]!.cells.find(c => c.column === 'weight_kg')!
    expect(off.ok).toBe(false)
    expect(off.message).toContain('empty string')
  })

  test('a constant is the same value on every row', () => {
    const model = reassign(buildModel(FILE, COLUMNS), 'weightKg', {
      kind: 'constant',
      column: 'note',
      text: 'bulk',
    })
    const rows = previewRows(model, COLUMNS, 10)
    for (const row of rows) {
      expect(row.cells.find(c => c.column === 'note')!.value).toBe('bulk')
    }
  })
})

describe('buildRecords', () => {
  test('good rows become records and bad rows become named failures', () => {
    const model = buildModel('id,Courier\n1,dhl\nabc,ups\n', COLUMNS)
    const built = buildRecords(model, COLUMNS)
    expect(built.records).toEqual([{ id: 1, courier: 'dhl' }])
    expect(built.failures.length).toBe(1)
    expect(built.failures[0]!.index).toBe(2)
    expect(built.failures[0]!.message).toContain('id:')
  })

  test('a skipped column is absent from the record, so the default applies', () => {
    const model = buildModel('Courier\ndhl\n', COLUMNS)
    expect(buildRecords(model, COLUMNS).records[0]).toEqual({ courier: 'dhl' })
  })
})

describe('rejected rows come back as a file', () => {
  test('the original fields, unmodified, plus a trailing _error', () => {
    const model = buildModel('id,Courier\nabc,ups\n', COLUMNS)
    const built = buildRecords(model, COLUMNS)
    const csv = rejectedCSV(model, built.failures)
    expect(csv.split('\r\n')[0]).toBe('id,Courier,_error')
    // `abc` unmodified: the text is exactly what explains the rejection.
    expect(csv.split('\r\n')[1]).toContain('abc,ups,')
  })
})

describe('writeCSV', () => {
  test('a field is quoted only when it has to be, and quotes double', () => {
    expect(writeCSV(['a', 'b'], [['x', 'y']])).toBe('a,b\r\nx,y')
    expect(writeCSV(['a'], [['x,y']])).toBe('a\r\n"x,y"')
    expect(writeCSV(['a'], [['he said "hi"']])).toBe('a\r\n"he said ""hi"""')
  })
})

describe('policy and chunking', () => {
  test('the bad-row policy is a field, not a guess', () => {
    expect(buildModel(FILE, COLUMNS).onBadRow).toBe('skip')
    expect(setBadRowPolicy(buildModel(FILE, COLUMNS), 'all').onBadRow).toBe(
      'all',
    )
  })

  test('chunk slices without losing or duplicating a row', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 2)).toEqual([])
  })
})
