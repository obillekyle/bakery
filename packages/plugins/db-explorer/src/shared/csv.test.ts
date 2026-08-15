import { describe, expect, test } from 'bun:test'
import { parseCSVRows, sniffDelimiter, stripBOM } from './csv'

/**
 * The four things `parseCSVRows` in `orm/adapters/base.ts` gets wrong are the
 * first four tests here — see this module's header for why it is a second
 * implementation rather than a fix to that one.
 */

describe('the ORM parser’s four defects', () => {
  test('a quote inside an unquoted field is a literal quote', () => {
    // The ORM's parser opens a quoted section on any `"`, so this collapses to
    // one field there.
    expect(parseCSVRows('he said "hi", ok')).toEqual([['he said "hi"', ' ok']])
  })

  test('a BOM does not become part of the first header', () => {
    expect(parseCSVRows('﻿id,name\n1,ana\n')[0]).toEqual(['id', 'name'])
    expect(stripBOM('﻿x')).toBe('x')
  })

  test('the delimiter is sniffed, not assumed to be a comma', () => {
    expect(sniffDelimiter('id;name\n1;ana\n')).toBe(';')
    expect(sniffDelimiter('id\tname\n1\tana\n')).toBe('\t')
    expect(sniffDelimiter('id|name\n1|ana\n')).toBe('|')
    expect(sniffDelimiter('id,name\n1,ana\n')).toBe(',')
  })

  test('a comma inside a quoted field does not decide the delimiter', () => {
    // A `;`-delimited export whose address column contains commas. Counting
    // commas naively picks `,` and the whole file parses as one column.
    const text = 'id;address\n1;"12 High St, Ely"\n2;"9 Mill Rd, Ware"\n'
    expect(sniffDelimiter(text)).toBe(';')
    expect(parseCSVRows(text, ';').slice(1)).toEqual([
      ['1', '12 High St, Ely'],
      ['2', '9 Mill Rd, Ware'],
    ])
  })
})

describe('RFC 4180 shapes', () => {
  test('doubled quotes, quoted newlines and CRLF', () => {
    const text = 'a,b\r\n"say ""hi""","two\nlines"\r\n'
    expect(parseCSVRows(text, ',')).toEqual([
      ['a', 'b'],
      ['say "hi"', 'two\nlines'],
    ])
  })

  test('a trailing newline is not a row, and a blank line is skipped', () => {
    expect(parseCSVRows('a\nb\n')).toEqual([['a'], ['b']])
    expect(parseCSVRows('a\n\nb')).toEqual([['a'], ['b']])
  })

  test('a quoted empty field on its own line is a real row', () => {
    // The distinction the ORM's `row.length === 1 && row[0] === ''` heuristic
    // cannot make: `""` is a value, a bare newline is not.
    expect(parseCSVRows('a\n""\n')).toEqual([['a'], ['']])
  })

  test('nothing is trimmed and nothing is typed', () => {
    expect(parseCSVRows('01, 2 ,true,null')).toEqual([
      ['01', ' 2 ', 'true', 'null'],
    ])
  })

  test('an empty input is no rows', () => {
    expect(parseCSVRows('')).toEqual([])
  })
})
