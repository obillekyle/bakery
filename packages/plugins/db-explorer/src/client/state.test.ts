import { describe, expect, test } from 'bun:test'
import type { SchemaTable } from './meta'
import {
  type AppState,
  createState,
  decodeView,
  defaultView,
  editableTable,
  encodeView,
  readOnlyReason,
  tableOf,
  type ViewState,
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
      page: 3,
      sortBy: 'courier',
      sortOrder: 'DESC',
      filters: { courier: 'dh' },
      focus: { id: 7 },
    }
    expect(decodeView(`#${encodeView(view)}`)).toEqual(view)
  })

  test('an ASC sort does not spend a parameter saying so', () => {
    const encoded = encodeView({ ...defaultView('t'), sortBy: 'a' })
    expect(encoded).not.toContain('o=')
    expect(decodeView(encoded).sortOrder).toBe('ASC')
  })

  test('a mangled link renders the page it asked for rather than an error', () => {
    // The hash is user-supplied; a truncated `r=` must not take the grid down.
    const view = decodeView('#t=parcels&r=%7Bbroken&f=notjson')
    expect(view.table).toBe('parcels')
    expect(view.focus).toBeNull()
    expect(view.filters).toEqual({})
  })

  test('an array where an object belongs is refused, not iterated', () => {
    expect(decodeView('#t=x&r=%5B1%2C2%5D').focus).toBeNull()
  })

  test('a nonsense page number falls back to one', () => {
    expect(decodeView('#t=x&p=-4').page).toBe(1)
    expect(decodeView('#t=x&p=abc').page).toBe(1)
  })

  test('an empty hash is the empty view, not a crash', () => {
    expect(decodeView('')).toEqual(defaultView(''))
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
