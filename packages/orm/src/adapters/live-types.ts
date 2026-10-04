import type * as SyncTypes from '../sync/types'
import type { SQLAdapter } from './base'

/**
 * Which live column types a declaration accepts, per dialect, for the check
 * migrations mode runs instead of a sync (`migrate/check.ts`).
 *
 * The question each rule answers is "would a query typed by this declaration
 * be right about what this column holds", which is looser than "is this the
 * type classic sync would have created": a declared `Field.Int()` is right
 * about a `smallint`, and a declared `Field.String()` about any `varchar`. A
 * width or a precision the declaration states is held to exactly; one it
 * leaves out is not asked about, the way an unsized `Field.String()` never
 * asked for a column to shrink.
 *
 * Pure functions of the declaration and the catalog's description, so the
 * rules are tested without a server.
 */

type Declared = SyncTypes.ColumnConstraint
type Live = SQLAdapter.LiveColumn

/** `declared X, the database has Y`. */
function mismatch(expected: string, live: Live): string {
  return `declared ${expected}, the database has ${live.type}`
}

/**
 * A native enum whose labels differ from the declared members. Text with a
 * CHECK is accepted unread: no catalog spells a CHECK's expression in a form
 * worth parsing here.
 */
function enumProblem(declared: Declared, live: Live): string | null {
  if (!declared._enum || !live.enumValues) return null
  const want = [...declared._enum].sort().join(', ')
  const have = [...live.enumValues].sort().join(', ')
  return want === have
    ? null
    : `declared the values ${want}, the database's enum has ${have}`
}

/** The base name and modifier of a type: `numeric(5,2)` is `numeric` and `(5,2)`. */
function splitModifier(type: string): { base: string; modifier: string } {
  const open = type.indexOf('(')
  if (open === -1) return { base: type, modifier: '' }
  const close = type.indexOf(')', open)
  const modifier = type.slice(open, close + 1).replace(/\s+/g, '')
  // Postgres puts a timestamp's precision in the middle:
  // `timestamp(3) with time zone`.
  const base = `${type.slice(0, open)}${type.slice(close + 1)}`
    .replace(/\s+/g, ' ')
    .trim()
  return { base, modifier }
}

/**
 * Two spellings that mean the same type, where `declared` may leave a width,
 * a precision or an array's element modifier unsaid.
 */
function sameType(declared: string, live: string): boolean {
  if (declared === live) return true
  const d = splitModifier(declared)
  const l = splitModifier(live)
  return d.base === l.base && (d.modifier === '' || d.modifier === l.modifier)
}

const PG_ALIASES: Record<string, string> = {
  int: 'integer',
  int4: 'integer',
  serial: 'integer',
  serial4: 'integer',
  int2: 'smallint',
  smallserial: 'smallint',
  serial2: 'smallint',
  int8: 'bigint',
  bigserial: 'bigint',
  serial8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  float: 'double precision',
  bool: 'boolean',
  varchar: 'character varying',
  char: 'character',
  bpchar: 'character',
  decimal: 'numeric',
  timestamptz: 'timestamp with time zone',
  timestamp: 'timestamp without time zone',
  timetz: 'time with time zone',
  time: 'time without time zone',
}

/**
 * A Postgres type as a declaration may spell it, in the spelling
 * `format_type()` reports: `timestamptz` is `timestamp with time zone`,
 * `varchar(64)` is `character varying(64)`, `int[]` is `integer[]`.
 */
export function normalizePgType(spelled: string): string {
  let type = spelled.trim().toLowerCase().replace(/\s+/g, ' ')
  let arrays = ''
  while (type.endsWith('[]')) {
    arrays += '[]'
    type = type.slice(0, -2).trim()
  }
  const { base, modifier } = splitModifier(type)
  const name = PG_ALIASES[base] ?? base
  if (modifier && name.startsWith('timestamp ')) {
    return `timestamp${modifier} ${name.slice('timestamp '.length)}${arrays}`
  }
  if (modifier && name.startsWith('time ')) {
    return `time${modifier} ${name.slice('time '.length)}${arrays}`
  }
  return `${name}${modifier}${arrays}`
}

/** Postgres: `live.type` is `format_type()`, a domain already resolved to its base. */
export function pgTypeProblem(declared: Declared, live: Live): string | null {
  const type = live.type
  const accepts = (ok: boolean, expected: string) =>
    ok ? null : mismatch(expected, live)

  switch (declared.type) {
    case 'integer':
      return accepts(
        type === 'integer' || type === 'smallint',
        'an integer (integer or smallint)',
      )
    case 'bigint':
      return accepts(type === 'bigint', 'bigint')
    case 'number':
      return accepts(
        type === 'double precision' || type === 'real',
        'a float (double precision or real)',
      )
    case 'boolean':
      return accepts(type === 'boolean', 'boolean')
    case 'json':
      return accepts(type === 'json' || type === 'jsonb', 'json or jsonb')
    case 'buffer':
      return accepts(type === 'bytea', 'bytea')
    case 'sql': {
      const want = normalizePgType(declared.sqlType ?? '')
      return accepts(sameType(want, type), want)
    }
    case 'string': {
      if (declared._enum) {
        const textual = type === 'text' || type.startsWith('character varying')
        if (!textual && !live.enumValues) {
          return mismatch('an enum (text, varchar, or a native enum)', live)
        }
        return enumProblem(declared, live)
      }
      // Field.Uuid is a 36-character string; a native uuid holds the same.
      if (declared.length === 36 && type === 'uuid') return null
      if (declared.length) {
        return accepts(
          type === `character varying(${declared.length})` ||
            type === `character(${declared.length})`,
          `varchar(${declared.length})`,
        )
      }
      return accepts(
        type === 'text' ||
          type === 'uuid' ||
          type === 'citext' ||
          type.startsWith('character varying') ||
          type.startsWith('character('),
        'text (text, varchar or char)',
      )
    }
  }
}

const MYSQL_ALIASES: Record<string, string> = {
  integer: 'int',
  bool: 'tinyint(1)',
  boolean: 'tinyint(1)',
  numeric: 'decimal',
  dec: 'decimal',
  'double precision': 'double',
  real: 'double',
}

/** A MySQL type the way `column_type` reports it: no display width on an integer. */
export function normalizeMysqlType(spelled: string): string {
  const type = spelled.trim().toLowerCase().replace(/\s+/g, ' ')
  if (MYSQL_ALIASES[type]) return MYSQL_ALIASES[type]!
  const { base, modifier } = splitModifier(type)
  const name = MYSQL_ALIASES[base] ?? base
  // `int(11)` is a display width, which MySQL 8 no longer reports: the type
  // is `int`. `tinyint(1)` is the exception everyone relies on to mean bool.
  if (/^(tinyint|smallint|mediumint|int|bigint)( unsigned)?$/.test(name)) {
    return modifier === '(1)' && name === 'tinyint' ? 'tinyint(1)' : name
  }
  return `${name}${modifier}`
}

/** MySQL: `live.type` is `column_type`, lower-cased. */
export function mysqlTypeProblem(
  declared: Declared,
  live: Live,
): string | null {
  const type = normalizeMysqlType(live.type)
  const accepts = (ok: boolean, expected: string) =>
    ok ? null : mismatch(expected, live)
  const integer = /^(tinyint|smallint|mediumint|int)( unsigned)?$/

  switch (declared.type) {
    case 'integer':
      return accepts(
        integer.test(type),
        'an integer (int, smallint, mediumint)',
      )
    case 'bigint':
      return accepts(type.startsWith('bigint'), 'bigint')
    case 'number':
      return accepts(
        type === 'double' || type === 'float',
        'a float (double or float)',
      )
    case 'boolean':
      return accepts(type === 'tinyint(1)', 'tinyint(1)')
    case 'json':
      return accepts(type === 'json', 'json')
    case 'buffer':
      return accepts(
        type.endsWith('blob') || type.startsWith('varbinary'),
        'a blob',
      )
    case 'sql': {
      const want = normalizeMysqlType(declared.sqlType ?? '')
      return accepts(sameType(want, type), want)
    }
    case 'string': {
      if (declared._enum) {
        if (type.startsWith('enum(')) {
          const labels = [...type.matchAll(/'((?:[^']|'')*)'/g)].map(m =>
            m[1]!.replace(/''/g, "'"),
          )
          return enumProblem(declared, { ...live, enumValues: labels })
        }
        return accepts(
          type.endsWith('text') || type.startsWith('varchar'),
          'an enum (enum, varchar or text)',
        )
      }
      if (declared.length) {
        return accepts(
          type === `varchar(${declared.length})` ||
            type === `char(${declared.length})`,
          `varchar(${declared.length})`,
        )
      }
      return accepts(
        type.endsWith('text') ||
          type.startsWith('varchar') ||
          type.startsWith('char('),
        'text (text, varchar or char)',
      )
    }
  }
}

/**
 * SQLite: `live.type` is the declared type text, which SQLite keeps but does
 * not enforce. The rules are its type affinity rules, so a column declared
 * `VARCHAR(10)` that holds text of any length still reads as text.
 */
export function sqliteTypeProblem(
  declared: Declared,
  live: Live,
): string | null {
  const type = live.type
  const accepts = (ok: boolean, expected: string) =>
    ok ? null : mismatch(expected, live)
  const integer = type.includes('int')
  const textual =
    type.includes('char') || type.includes('clob') || type.includes('text')
  const real =
    type.includes('real') || type.includes('floa') || type.includes('doub')

  switch (declared.type) {
    case 'integer':
    case 'bigint':
      return accepts(integer, 'an integer')
    case 'boolean':
      return accepts(integer || type.includes('bool'), 'an integer or boolean')
    case 'number':
      return accepts(real || type.includes('numeric'), 'a real')
    case 'json':
      return accepts(type.includes('json') || textual, 'json or text')
    case 'buffer':
      return accepts(type === '' || type.includes('blob'), 'a blob')
    case 'sql': {
      const want = (declared.sqlType ?? '').trim().toLowerCase()
      return accepts(sameType(want, type.replace(/\s+/g, ' ')), want)
    }
    case 'string': {
      if (declared.length && /\(\d+\)/.test(type)) {
        return accepts(
          type === `varchar(${declared.length})` ||
            type === `character varying(${declared.length})`,
          `varchar(${declared.length})`,
        )
      }
      return accepts(textual, 'text')
    }
  }
}
