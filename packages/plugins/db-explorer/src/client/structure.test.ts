import { describe, expect, test } from 'bun:test'
import type { SchemaColumn, SchemaIndex, SchemaTable } from './meta'
import { structureRow, structureRows } from './structure'

const column = (over: Partial<SchemaColumn> = {}): SchemaColumn => ({
  name: 'id',
  type: 'INTEGER',
  notnull: true,
  pk: false,
  kind: 'integer',
  nullable: false,
  hasDefault: false,
  ...over,
})

describe('a column as the Structure view shows it', () => {
  test('the declared type carries its length when there is one', () => {
    const row = structureRow(
      column({ name: 'code', type: 'VARCHAR', length: 12 }),
      [],
    )
    expect(row.type).toBe('VARCHAR(12)')
  })

  test('a type with no length is shown unchanged', () => {
    expect(structureRow(column({ type: 'TEXT' }), []).type).toBe('TEXT')
  })

  test('nullability is the word, not a tick', () => {
    expect(structureRow(column({ nullable: true }), []).nullable).toBe('NULL')
    expect(structureRow(column({ nullable: false }), []).nullable).toBe(
      'NOT NULL',
    )
  })

  test('nullable is read, not `!notnull`', () => {
    // The server sends both, from two different introspection calls, and
    // `nullable` is the richer one — it is what the editors obey, so it is
    // what the view must show.
    const row = structureRow(column({ nullable: true, notnull: true }), [])
    expect(row.nullable).toBe('NULL')
  })

  test('auto-increment is reported as AUTO, not as a default', () => {
    // They are different facts and differ where it matters —
    // `omittableOnInsert`. Conflating them teaches the wrong model.
    const row = structureRow(
      column({ autoIncrement: true, hasDefault: false }),
      [],
    )
    expect(row.default).toBe('AUTO')
  })

  test('AUTO wins over DEFAULT when a column has both', () => {
    expect(
      structureRow(column({ autoIncrement: true, hasDefault: true }), [])
        .default,
    ).toBe('AUTO')
  })

  test('a plain default says so, and no default says nothing', () => {
    expect(structureRow(column({ hasDefault: true }), []).default).toBe(
      'DEFAULT',
    )
    expect(structureRow(column(), []).default).toBe('')
  })

  test('a primary key column is PK', () => {
    expect(structureRow(column({ pk: true }), []).key).toBe('PK')
  })

  test('a unique index makes a column a key', () => {
    const indexes: SchemaIndex[] = [
      { name: 'ux_email', type: 'unique', cols: ['email'] },
    ]
    expect(structureRow(column({ name: 'email' }), [], indexes).key).toBe(
      'unique',
    )
  })

  test('a PLAIN index does NOT', () => {
    // A plain index makes a column faster to look up and does nothing to make
    // a row nameable. Calling both "key" is how someone concludes a table is
    // addressable when it is not.
    const indexes: SchemaIndex[] = [
      { name: 'ix_email', type: 'index', cols: ['email'] },
    ]
    expect(structureRow(column({ name: 'email' }), [], indexes).key).toBe('')
  })

  test('PK wins over unique when a column is both', () => {
    const indexes: SchemaIndex[] = [
      { name: 'ux_id', type: 'unique', cols: ['id'] },
    ]
    expect(structureRow(column({ pk: true }), [], indexes).key).toBe('PK')
  })

  test('enum members are listed', () => {
    const row = structureRow(
      column({ name: 'state', kind: 'string', enum: ['new', 'sent'] }),
      [],
    )
    expect(row.values).toBe('new, sent')
  })

  test('a column with no enum lists nothing', () => {
    expect(structureRow(column(), []).values).toBe('')
  })

  test('identity membership comes from the resolved identity, not from pk', () => {
    // A table keyed by a unique index has identity columns that are not `pk`.
    const row = structureRow(column({ name: 'email', pk: false }), ['email'])
    expect(row.identity).toBe(true)
    expect(structureRow(column({ name: 'other' }), ['email']).identity).toBe(
      false,
    )
  })
})

describe('structureRows over a whole table', () => {
  const table: SchemaTable = {
    name: 'users',
    rowCount: 3,
    columns: [
      column({ name: 'id', pk: true, autoIncrement: true }),
      column({ name: 'email', type: 'VARCHAR', length: 200, kind: 'string' }),
    ],
    identity: { mode: 'pk', cols: ['id'] },
    indexes: [{ name: 'ux_email', type: 'unique', cols: ['email'] }],
    writable: true,
  }

  test('one row per column, in schema order', () => {
    expect(structureRows(table).map(row => row.name)).toEqual(['id', 'email'])
  })

  test('the indexes on the table reach the rows derived from them', () => {
    expect(structureRows(table)[1]?.key).toBe('unique')
  })

  test('a table with no indexes field does not throw', () => {
    const bare: SchemaTable = { ...table, indexes: undefined }
    expect(structureRows(bare).map(row => row.key)).toEqual(['PK', ''])
  })
})
