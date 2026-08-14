import { describe, expect, test } from 'bun:test'
import type { SchemaTable } from './meta'
import {
  type AppState,
  createState,
  decodeView,
  defaultView,
  editableTable,
  encodeView,
  isSystemTable,
  readOnlyReason,
  systemTableCount,
  tableOf,
  type ViewState,
  visibleTables,
} from './state'

const table = (over: Partial<SchemaTable> = {}): SchemaTable => ({
  name: 'parcels',
  rowCount: 1,
  columns: [],
  identity: { mode: 'pk', cols: ['id'] },
  writable: true,
  ...over,
})

const state = (over: Partial<AppState> = {}): AppState => ({
  ...createState(),
  report: { access: 'write', tables: [table()] },
  ...over,
})

describe('view state in the URL', () => {
  test('the common case is short — defaults are omitted, not written', () => {
    expect(encodeView(defaultView('parcels'))).toBe('t=parcels')
  })

  test('a full view round trips', () => {
    const view: ViewState = {
      table: 'parcels',
      view: 'structure',
      page: 3,
      sortBy: 'courier',
      sortOrder: 'DESC',
      filters: [{ column: 'courier', op: 'contains', value: 'dh' }],
    }
    expect(decodeView(`#${encodeView(view)}`)).toEqual(view)
  })

  test('an ASC sort does not spend a parameter saying so', () => {
    const encoded = encodeView({ ...defaultView('t'), sortBy: 'a' })
    expect(encoded).not.toContain('o=')
    expect(decodeView(encoded).sortOrder).toBe('ASC')
  })

  test('the Data view does not spend a parameter saying so either', () => {
    expect(encodeView(defaultView('t'))).not.toContain('v=')
    expect(decodeView('#t=x').view).toBe('data')
  })

  test('an unknown view name falls back to Data rather than rendering nothing', () => {
    expect(decodeView('#t=x&v=sql').view).toBe('data')
  })

  test('a mangled link renders the page it asked for rather than an error', () => {
    // The hash is user-supplied; a truncated `f=` must not take the grid down.
    const view = decodeView('#t=parcels&f=notjson')
    expect(view.table).toBe('parcels')
    expect(view.filters).toEqual([])
  })

  test('a filter carrying an unknown operator is dropped, not sent', () => {
    // The ORM *drops* an operator it does not know, which widens the result —
    // so a hand-edited link must not be able to smuggle one through.
    const raw = encodeURIComponent(
      JSON.stringify([
        { column: 'a', op: 'eq', value: '1' },
        { column: 'b', op: 'regex', value: '.*' },
      ]),
    )
    expect(decodeView(`#t=x&f=${raw}`).filters).toEqual([
      { column: 'a', op: 'eq', value: '1' },
    ])
  })

  test('an object where a filter list belongs is refused, not iterated', () => {
    expect(decodeView('#t=x&f=%7B%22a%22%3A%22b%22%7D').filters).toEqual([])
  })

  test('a nonsense page number falls back to one', () => {
    expect(decodeView('#t=x&p=-4').page).toBe(1)
    expect(decodeView('#t=x&p=abc').page).toBe(1)
  })

  test('an empty hash is the empty view, not a crash', () => {
    expect(decodeView('')).toEqual(defaultView(''))
  })

  test('a pre-tabs link that carried a row identity still opens its page', () => {
    // `r=` was the focused-row identity, removed when `eq` filters made it
    // unnecessary. Old links are in bookmarks and chat logs.
    const view = decodeView('#t=parcels&p=2&r=%7B%22id%22%3A7%7D')
    expect(view.table).toBe('parcels')
    expect(view.page).toBe(2)
  })
})

describe('system tables', () => {
  const ledger = table({ name: '__bakery_schema' })

  test('the ORM sync ledger is a system table', () => {
    expect(isSystemTable('__bakery_schema')).toBe(true)
  })

  test('the reserved prefix is matched, not the one literal name', () => {
    expect(isSystemTable('__bakery_anything')).toBe(true)
  })

  test("a user's table is not one, even when it looks close", () => {
    expect(isSystemTable('bakery_schema')).toBe(false)
    expect(isSystemTable('_bakery_schema')).toBe(false)
    expect(isSystemTable('parcels')).toBe(false)
  })

  test('they are hidden by default and revealed by the toggle', () => {
    const all = [table(), ledger]
    expect(visibleTables(all, false).map(t => t.name)).toEqual(['parcels'])
    expect(visibleTables(all, true).map(t => t.name)).toEqual([
      'parcels',
      '__bakery_schema',
    ])
  })

  test('the count is what the checkbox label promises to reveal', () => {
    expect(systemTableCount([table(), ledger])).toBe(1)
    expect(systemTableCount([table()])).toBe(0)
  })
})

describe('editability, decided before first paint', () => {
  test('a write session on a writable table may edit', () => {
    expect(editableTable(state(), table())).toBe(true)
  })

  test('a read session may not, whatever the table says', () => {
    const readOnly = state({ report: { access: 'read', tables: [table()] } })
    expect(editableTable(readOnly, table())).toBe(false)
  })

  test('a table with no identity is read-only for a write session too', () => {
    const noKey = table({
      writable: false,
      identity: { mode: 'none', cols: [], reason: 'no primary key' },
      reason: 'no primary key',
    })
    expect(editableTable(state(), noKey)).toBe(false)
    expect(readOnlyReason(state(), noKey)).toBe('no primary key')
  })

  test('the reason is the server’s words, never invented here', () => {
    const denied = state({
      report: {
        access: 'read',
        tables: [table({ reason: 'this session may read but not write' })],
      },
    })
    expect(
      readOnlyReason(
        denied,
        table({ reason: 'this session may read but not write' }),
      ),
    ).toBe('this session may read but not write')
  })
})

describe('tableOf', () => {
  test('finds a table by its raw name', () => {
    expect(tableOf(state(), 'parcels')?.name).toBe('parcels')
    expect(tableOf(state(), 'nope')).toBeUndefined()
  })
})
