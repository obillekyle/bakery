import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { is } from '@bakery/core/utils/common'
// The same binding `client/utils.ts` publishes to the browser as `escapeHTML`.
import { escapeHtml } from '@bakery/core/utils/http/escape'
import {
  buildResultTableHtml,
  buildTableHtml,
  formatTableCell,
  schemaListMessage,
} from './database'

/**
 * The dashboard's grid is built by string concatenation into `innerHTML`, from
 * values that are *database rows* — i.e. whatever the last writer put there.
 * Anyone who can write a row would own the operator's session, and that origin
 * owns `/api/_dashboard/query`: stored XSS to arbitrary SQL.
 *
 * These are the pure builders only. `escapeHTML` and `is` are runtime globals
 * in the browser bundle (`client/globals.d.ts`), bound here to the real
 * implementations — a stub would let an assertion pass against markup the real
 * escaper would have left alone. Saved and restored rather than assigned,
 * because `globalThis` is shared with every other file in the test process.
 */
const priorEscape = (globalThis as any).escapeHTML
const priorIs = (globalThis as any).is

beforeAll(() => {
  ;(globalThis as any).escapeHTML = escapeHtml
  ;(globalThis as any).is = is
})

afterAll(() => {
  ;(globalThis as any).escapeHTML = priorEscape
  ;(globalThis as any).is = priorIs
})

/** The payload every case below stores, and what it must never become. */
const PAYLOAD = '<img src=x onerror=alert(1)>'
const RAW = '<img src=x onerror=alert(1)>'

describe('dashboard grid escaping', () => {
  test('a JSON-typed cell is escaped, not stringified raw', () => {
    // The sibling branches escaped and this one did not. Any JSON or array
    // column lands here — `is.object([])` is true by a documented decision, so
    // an array value takes this branch too.
    const html = formatTableCell({ note: PAYLOAD }, 'meta', 1)

    expect(html).not.toContain(RAW)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('an array-typed cell takes the same escaped branch', () => {
    const html = formatTableCell([PAYLOAD], 'tags', 1)

    expect(html).not.toContain(RAW)
    expect(html).toContain('cell-json')
  })

  test('the SQL console result grid escapes a JSON-typed cell', () => {
    const html = buildResultTableHtml([{ meta: { note: PAYLOAD } }], ['meta'])

    expect(html).not.toContain(RAW)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('a user-supplied rowid column is escaped in its own cell', () => {
    // `rowid` is SQLite's implicit integer only until a table declares a column
    // by that name; then it is a row value like any other. The two inline
    // handlers coerce it with Number(); this cell renders it, so it escapes.
    const html = buildTableHtml([{ rowid: PAYLOAD, name: 'a' }], ['name'], true)

    expect(html).not.toContain(RAW)
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('rowid still reaches the inline handlers as a number, never as text', () => {
    // Escaping is not sufficient inside an `on*=` attribute — the parser
    // entity-decodes before the JS compiles — so these two sites must stay
    // numeric. NaN is inert; the payload text would not be.
    const html = buildTableHtml([{ rowid: PAYLOAD, name: 'a' }], ['name'], true)

    expect(html).toContain('deleteTableRow(this.dataset.table, NaN)')
    expect(html).toContain(
      'startInlineEdit(this, this.dataset.table, NaN, this.dataset.col)',
    )
  })

  test('the schema list placeholder escapes its message', () => {
    // Same shape that was already removed from `emptyBox`: a string straight
    // into innerHTML, safe only for as long as every caller passes a literal.
    const list = { innerHTML: '' }
    schemaListMessage(list as unknown as HTMLElement, PAYLOAD)

    expect(list.innerHTML).not.toContain(RAW)
    expect(list.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  test('ordinary values still render as themselves', () => {
    // Guards the other direction: an over-eager fix that escaped twice would
    // show `&amp;lt;` to the operator.
    expect(formatTableCell('plain text', 'col', 1)).toContain('plain text')
    expect(buildResultTableHtml([{ a: 'plain' }], ['a'])).toContain('plain')
  })
})
