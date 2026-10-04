import { describe, expect, test } from 'bun:test'
import { Field } from '../field'
import type * as SyncTypes from '../sync/types'
import type { SQLAdapter } from './base'
import {
  mysqlTypeProblem,
  normalizeMysqlType,
  normalizePgType,
  pgTypeProblem,
  sqliteTypeProblem,
} from './live-types'

const live = (
  type: string,
  extra: Partial<SQLAdapter.LiveColumn> = {},
): SQLAdapter.LiveColumn => ({
  table: 't',
  column: 'c',
  type,
  nullable: false,
  primary: false,
  view: false,
  ...extra,
})

const def = (field: unknown) => field as SyncTypes.ColumnConstraint

describe('normalizePgType', () => {
  test('spells a type the way format_type() reports it', () => {
    expect(normalizePgType('timestamptz')).toBe('timestamp with time zone')
    expect(normalizePgType('VARCHAR(64)')).toBe('character varying(64)')
    expect(normalizePgType('int[]')).toBe('integer[]')
    expect(normalizePgType('decimal(10, 2)')).toBe('numeric(10,2)')
    expect(normalizePgType('timestamptz(3)')).toBe(
      'timestamp(3) with time zone',
    )
    expect(normalizePgType('bigserial')).toBe('bigint')
    expect(normalizePgType('numeric[]')).toBe('numeric[]')
  })
})

describe('pgTypeProblem', () => {
  test('a declared integer accepts integer and smallint, not bigint', () => {
    expect(pgTypeProblem(def(Field.Int()), live('integer'))).toBeNull()
    expect(pgTypeProblem(def(Field.Int()), live('smallint'))).toBeNull()
    // Bun returns a bigint as a string: a number-typed query would be wrong.
    expect(pgTypeProblem(def(Field.Int()), live('bigint'))).toBe(
      'declared an integer (integer or smallint), the database has bigint',
    )
  })

  test('a declared width is held to; an unsized string is not', () => {
    expect(
      pgTypeProblem(def(Field.Varchar(64)), live('character varying(64)')),
    ).toBeNull()
    expect(
      pgTypeProblem(def(Field.Varchar(64)), live('character varying(80)')),
    ).toBe('declared varchar(64), the database has character varying(80)')
    expect(
      pgTypeProblem(def(Field.String()), live('character varying(80)')),
    ).toBeNull()
    expect(pgTypeProblem(def(Field.String()), live('text'))).toBeNull()
  })

  test('a declared Uuid accepts a native uuid', () => {
    expect(pgTypeProblem(def(Field.Uuid()), live('uuid'))).toBeNull()
  })

  test('a Json accepts json and jsonb; a Bool, boolean', () => {
    expect(pgTypeProblem(def(Field.Json()), live('jsonb'))).toBeNull()
    expect(pgTypeProblem(def(Field.Json()), live('json'))).toBeNull()
    expect(pgTypeProblem(def(Field.Bool()), live('integer'))).toBe(
      'declared boolean, the database has integer',
    )
  })

  test('an enum accepts text, or a native enum with the same labels', () => {
    const status = def(Field.Enum(['draft', 'live']))
    expect(pgTypeProblem(status, live('text'))).toBeNull()
    expect(
      pgTypeProblem(status, live('status', { enumValues: ['live', 'draft'] })),
    ).toBeNull()
    expect(
      pgTypeProblem(
        status,
        live('status', { enumValues: ['draft', 'live', 'gone'] }),
      ),
    ).toBe(
      "declared the values draft, live, the database's enum has draft, gone, live",
    )
  })

  test('Field.Sql compares spellings, and an unstated modifier is not asked about', () => {
    expect(
      pgTypeProblem(
        def(Field.Sql('timestamptz')),
        live('timestamp with time zone'),
      ),
    ).toBeNull()
    expect(
      pgTypeProblem(def(Field.Sql('numeric')), live('numeric(5,2)')),
    ).toBeNull()
    expect(
      pgTypeProblem(def(Field.Sql('numeric(5,2)')), live('numeric(5,2)')),
    ).toBeNull()
    expect(
      pgTypeProblem(def(Field.Sql('numeric(5,2)')), live('numeric(6,2)')),
    ).toBe('declared numeric(5,2), the database has numeric(6,2)')
    expect(pgTypeProblem(def(Field.Sql('int[]')), live('integer[]'))).toBeNull()
    expect(pgTypeProblem(def(Field.Sql('text[]')), live('integer[]'))).toBe(
      'declared text[], the database has integer[]',
    )
  })
})

describe('MySQL', () => {
  test('a display width is not part of the type, except tinyint(1)', () => {
    expect(normalizeMysqlType('int(11)')).toBe('int')
    expect(normalizeMysqlType('INTEGER')).toBe('int')
    expect(normalizeMysqlType('tinyint(1)')).toBe('tinyint(1)')
    expect(normalizeMysqlType('bool')).toBe('tinyint(1)')
    expect(normalizeMysqlType('numeric(10,2)')).toBe('decimal(10,2)')
  })

  test('the declarations map the way the adapter creates them', () => {
    expect(mysqlTypeProblem(def(Field.Int()), live('int'))).toBeNull()
    expect(mysqlTypeProblem(def(Field.Bool()), live('tinyint(1)'))).toBeNull()
    expect(
      mysqlTypeProblem(def(Field.Varchar(64)), live('varchar(64)')),
    ).toBeNull()
    expect(mysqlTypeProblem(def(Field.Json()), live('json'))).toBeNull()
    expect(mysqlTypeProblem(def(Field.Int()), live('bigint'))).toBe(
      'declared an integer (int, smallint, mediumint), the database has bigint',
    )
  })

  test("an ENUM's labels are read out of its column type", () => {
    const status = def(Field.Enum(['draft', 'live']))
    expect(mysqlTypeProblem(status, live("enum('draft','live')"))).toBeNull()
    expect(mysqlTypeProblem(status, live("enum('draft','it''s')"))).toBe(
      "declared the values draft, live, the database's enum has draft, it's",
    )
  })
})

describe('SQLite', () => {
  test('types compare by affinity', () => {
    expect(sqliteTypeProblem(def(Field.Int()), live('integer'))).toBeNull()
    expect(sqliteTypeProblem(def(Field.Int()), live('bigint'))).toBeNull()
    expect(
      sqliteTypeProblem(def(Field.String()), live('varchar(80)')),
    ).toBeNull()
    expect(sqliteTypeProblem(def(Field.Float()), live('real'))).toBeNull()
    expect(sqliteTypeProblem(def(Field.String()), live('integer'))).toBe(
      'declared text, the database has integer',
    )
  })
})
