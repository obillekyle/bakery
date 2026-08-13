import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { LIMITS } from './policy'
import { __resetTestAccess, __setTestAccess, DbExplorerHandler } from './setup'

/**
 * The write surface, end to end through the handler.
 *
 * The stub records **statements**, not just method names, because almost every
 * claim here is about the SQL that was or was not emitted: an identity
 * predicate rather than a rowid, an `expect` appended to it, and — for the
 * bounds — nothing at all.
 */

const SCHEMA = [
  {
    name: 'parcels',
    rowCount: 2,
    columns: [
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'courier', type: 'TEXT', notnull: true, pk: false },
      { name: 'weight', type: 'REAL', notnull: false, pk: false },
      { name: 'meta', type: 'JSON', notnull: false, pk: false },
    ],
    indexes: [],
  },
  {
    name: 'parcel_legs',
    rowCount: 3,
    columns: [
      { name: 'parcel_id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'leg_no', type: 'INTEGER', notnull: true, pk: true },
      { name: 'carrier', type: 'TEXT', notnull: true, pk: false },
    ],
    indexes: [],
  },
  {
    name: 'notes',
    rowCount: 1,
    columns: [{ name: 'body', type: 'TEXT', notnull: false, pk: false }],
    indexes: [],
  },
]

const CONSTRAINTS: any = {
  parcels: {
    id: {
      type: 'integer',
      primary: true,
      nullable: false,
      autoIncrement: true,
    },
    courier: { type: 'string', nullable: false },
    weight: { type: 'number', nullable: true },
    meta: { type: 'json', nullable: true },
  },
  parcelLegs: {
    parcelId: { type: 'integer', primary: true, nullable: false },
    legNo: { type: 'integer', primary: true, nullable: false },
    carrier: { type: 'string', nullable: false },
  },
  notes: { body: { type: 'string', nullable: true } },
}

/**
 * The stub's method list *is* the contract, and it now enumerates a **bounded
 * write surface** rather than none.
 *
 * Four introspection reads, `getData`, and two ways to run a statement —
 * `query()` for the builder and `execute` for a batched insert — inside a
 * `transaction` that records whether it committed or rolled back. Nothing here
 * can create, drop or alter a table, and nothing takes SQL from a request. An
 * endpoint that reached for `drop`, `truncate`, `syncSchema`, `remove` or the
 * adapter's `update(table, rowid, row)` triple would fail with a TypeError
 * naming the capability it wanted.
 */
function createStubDb() {
  const calls: string[] = []
  const statements: { sql: string; params: unknown[] }[] = []
  const tx = { committed: 0, rolledBack: 0 }
  const state = {
    changes: 1,
    /** What a probing SELECT finds. */
    row: null as Record<string, unknown> | null,
  }

  const record = (sql: string, params: unknown[]) => {
    statements.push({ sql, params })
    calls.push(sql.trim().split(/\s+/)[0]!.toUpperCase())
  }

  const answer = <T>(name: string, value: T) => {
    calls.push(name)
    return value
  }
  const runResult = () => ({ changes: state.changes, lastInsertRowid: 1 })
  const allResult = () => (state.row ? [state.row] : [])

  const db: any = {
    quoteChar: '"',
    maxQueryParams: 32766,
    getSchema: async () => answer('getSchema', SCHEMA),
    getConstraints: async () => answer('getConstraints', CONSTRAINTS),
    getIndexes: async () => answer('getIndexes', {}),
    getForeignKeys: async () => answer('getForeignKeys', {}),
    getData: async (table: string, opts: any) =>
      answer(`getData:${table}:${opts.page}`, {
        rows: [],
        totalRows: 0,
        page: 1,
        pageSize: 50,
        totalPages: 0,
      }),
    query(sql: string) {
      return {
        run: (...params: unknown[]) => {
          record(sql, params)
          return runResult()
        },
        get: (...params: unknown[]) => {
          record(sql, params)
          return state.row
        },
        all: (...params: unknown[]) => {
          record(sql, params)
          return allResult()
        },
      }
    },
    execute: {
      run: (sql: string, params: unknown[] = []) => {
        record(sql, params)
        return runResult()
      },
      all: (sql: string, params: unknown[] = []) => {
        record(sql, params)
        return allResult()
      },
    },
    async transaction(callback: (tx: unknown) => Promise<unknown>) {
      try {
        const out = await callback(db)
        tx.committed++
        return out
      } catch (error) {
        tx.rolledBack++
        throw error
      }
    },
  }

  return { db, calls, statements, tx, state }
}

const stub = createStubDb()

beforeAll(async () => {
  await initConfig()
  __setTestDb(stub.db)
})

afterAll(() => {
  __resetTestDb()
  __resetTestAccess()
})

beforeEach(() => {
  stub.calls.length = 0
  stub.statements.length = 0
  stub.tx.committed = 0
  stub.tx.rolledBack = 0
  stub.state.changes = 1
  stub.state.row = null
  __setTestAccess({ authorize: () => 'write' })
})

/** Statements only — the introspection reads are not SQL the stub sees. */
const emitted = () => stub.statements.map(s => s.sql)

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return await DbExplorerHandler.handle(path, req)
}

describe('the write surface is bounded, and this is its boundary', () => {
  test('the dashboard’s three write paths are still 404 here', async () => {
    for (const path of [
      '/api/_db/query',
      '/api/_db/execute-action',
      '/api/_db/sessions/delete',
    ]) {
      const res = (await call('POST', path, {})) as Response
      expect(`${path}:${res.status}`).toBe(`${path}:404`)
    }
    expect(emitted()).toEqual([])
  })

  test('every statement the plugin can emit is an INSERT, UPDATE, DELETE or SELECT', async () => {
    // The claim that replaced "no non-`get*` DB call": the plugin writes rows
    // and nothing else. No DDL, and no statement text from a request.
    await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: 'dhl' }],
    })
    await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'ups' },
      expect: {},
    })
    await call('DELETE', '/api/_db/rows', {
      table: 'parcels',
      keys: [{ id: 1 }],
    })

    const verbs = new Set(emitted().map(sql => sql.split(/\s+/)[0]))
    expect([...verbs].sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
    for (const sql of emitted()) {
      expect(sql).not.toMatch(/\b(DROP|ALTER|CREATE|TRUNCATE|PRAGMA)\b/i)
    }
  })

  test('a method the key does not name is not routed', async () => {
    // `POST /api/_db/rows` is method-qualified, so a GET to it is a 404 rather
    // than a handler deciding for itself.
    const res = (await call('GET', '/api/_db/rows')) as Response
    expect(res.status).toBe(404)
  })
})

describe('a read caller', () => {
  beforeEach(() => {
    __setTestAccess({ authorize: () => 'read' })
  })

  test('gets 403 from every write route, and emits nothing', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/_db/rows', { table: 'parcels', rows: [{ courier: 'x' }] }],
      [
        'PATCH',
        '/api/_db/row',
        { table: 'parcels', key: { id: 1 }, set: { courier: 'x' }, expect: {} },
      ],
      [
        'POST',
        '/api/_db/rows/bulk',
        {
          table: 'parcels',
          edits: [{ key: { id: 1 }, set: { courier: 'x' } }],
        },
      ],
      ['DELETE', '/api/_db/rows', { table: 'parcels', keys: [{ id: 1 }] }],
      [
        'POST',
        '/api/_db/import',
        { table: 'parcels', rows: [{ courier: 'x' }], onBadRow: 'stop' },
      ],
    ]

    for (const [method, path, body] of attempts) {
      const res = await call(method, path, body)
      expect(`${path}:${res.status}`).toBe(`${path}:403`)
    }
    expect(emitted()).toEqual([])
    // Refused before the body could even name a table.
    expect(stub.calls).not.toContain('getSchema')
  })

  test('still reads the schema, and is told its own posture', async () => {
    const res = await call('GET', '/api/_db/schema')
    expect(res.status).toBe(200)
    expect(res.data.access).toBe('read')
    const parcels = res.data.tables.find((t: any) => t.name === 'parcels')
    expect(parcels.writable).toBe(false)
    expect(parcels.reason).toContain('read but not write')
  })
})

describe('identity decides whether a row can be named at all', () => {
  test('a table with no primary key and no unique index answers 409', async () => {
    const res = await call('PATCH', '/api/_db/row', {
      table: 'notes',
      key: { body: 'x' },
      set: { body: 'y' },
      expect: {},
    })
    expect(res.status).toBe(409)
    expect(res.message).toContain('read-only')
    expect(emitted()).toEqual([])
  })

  test('/api/_db/schema says so, and why, before the client renders', async () => {
    const res = await call('GET', '/api/_db/schema')
    const notes = res.data.tables.find((t: any) => t.name === 'notes')
    expect(notes.writable).toBe(false)
    expect(notes.identity).toEqual({
      mode: 'none',
      cols: [],
      reason: expect.stringContaining('no way to name one row'),
    })
    const legs = res.data.tables.find((t: any) => t.name === 'parcel_legs')
    expect(legs.identity).toEqual({
      mode: 'pk',
      cols: ['parcel_id', 'leg_no'],
    })
  })

  test('a key naming the wrong column set is 400, not a widened predicate', async () => {
    // Half of a composite key would match every row sharing the other half —
    // the dashboard's MySQL bug, refused here rather than executed.
    const partial = await call('PATCH', '/api/_db/row', {
      table: 'parcel_legs',
      key: { parcel_id: 1 },
      set: { carrier: 'ups' },
      expect: {},
    })
    expect(partial.status).toBe(400)
    expect(partial.data.errors[0].code).toBe('key_mismatch')

    const extra = await call('PATCH', '/api/_db/row', {
      table: 'parcel_legs',
      key: { parcel_id: 1, leg_no: 2, carrier: 'dhl' },
      set: { carrier: 'ups' },
      expect: {},
    })
    expect(extra.status).toBe(400)
    expect(extra.data.errors[0].code).toBe('key_mismatch')

    expect(emitted()).toEqual([])
  })

  test('a composite key becomes a composite predicate, never a rowid', async () => {
    await call('PATCH', '/api/_db/row', {
      table: 'parcel_legs',
      key: { parcel_id: 1, leg_no: 2 },
      set: { carrier: 'ups' },
      expect: {},
    })
    const update = emitted().find(sql => sql.startsWith('UPDATE'))!
    expect(update).toContain('"parcel_id" = ?')
    expect(update).toContain('"leg_no" = ?')
    expect(update).not.toMatch(/rowid|ctid|oid/i)
    expect(stub.statements[0]!.params).toEqual(['ups', 1, 2])
  })
})

describe('optimistic concurrency', () => {
  test('expect is appended to the identity predicate', async () => {
    await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'ups' },
      expect: { courier: 'dhl' },
    })
    const update = emitted()[0]!
    expect(update).toContain('WHERE "id" = ? AND "courier" = ?')
    expect(stub.statements[0]!.params).toEqual(['ups', 1, 'dhl'])
  })

  test('zero changes with no matching row is a 409 carrying the current row', async () => {
    stub.state.changes = 0
    stub.state.row = null
    const res = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'ups' },
      expect: { courier: 'dhl' },
    })
    expect(res.status).toBe(409)
    expect(res.data.changed).toBe(0)
  })

  test('zero changes with the row still matching is a no-op, not a conflict', async () => {
    // MySQL reports zero changed rows for an UPDATE that set a column to the
    // value it already held. Without this probe every such edit is a 409.
    stub.state.changes = 0
    stub.state.row = { id: 1, courier: 'dhl' }
    const res = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'dhl' },
      expect: { courier: 'dhl' },
    })
    expect(res.status).toBe(200)
    expect(res.data.changed).toBe(0)
    expect(res.data.row).toEqual({ id: 1, courier: 'dhl' })
    // The probe ran inside the transaction the UPDATE ran in.
    expect(stub.tx.committed).toBe(1)
    expect(emitted().filter(s => s.startsWith('SELECT')).length).toBe(1)
  })

  test('expect on a json column is refused — no dialect can compare one', async () => {
    const res = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'ups' },
      expect: { meta: '{}' },
    })
    expect(res.status).toBe(400)
    expect(res.data.errors[0].code).toBe('uncomparable')
  })

  test('changing a json column needs force, since it cannot be guarded', async () => {
    const refused = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { meta: '{"a":1}' },
      expect: {},
    })
    expect(refused.status).toBe(400)
    expect(refused.message).toContain('force')
    expect(emitted()).toEqual([])

    const forced = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { meta: '{"a":1}' },
      expect: {},
      force: true,
    })
    expect(forced.status).toBe(200)
  })

  test('expect is required, so last-write-wins is never the default', async () => {
    const res = await call('PATCH', '/api/_db/row', {
      table: 'parcels',
      key: { id: 1 },
      set: { courier: 'ups' },
    })
    expect(res.status).toBe(400)
    expect(res.message).toContain('expect is required')
  })
})

describe('values on the wire', () => {
  test('"" into a NOT NULL text column is the empty string, and null is refused', async () => {
    const empty = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: '' }],
    })
    expect(empty.status).toBe(200)
    expect(stub.statements[0]!.params).toEqual([''])

    const nulled = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: null }],
    })
    expect(nulled.status).toBe(400)
    expect(nulled.data.errors[0].code).toBe('not_null')
  })

  test('"" into a numeric column is an error, not zero', async () => {
    const res = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: 'dhl', weight: '' }],
    })
    expect(res.status).toBe(400)
    expect(res.data.errors[0].code).toBe('empty_string')
    expect(emitted()).toEqual([])
  })

  test('an unknown column is a 400, never silently dropped', async () => {
    const res = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: 'dhl', couriar: 'typo' }],
    })
    expect(res.status).toBe(400)
    expect(res.data.errors[0].code).toBe('unknown_column')
  })

  test('errors accumulate across rows and columns', async () => {
    const res = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ courier: null }, { weight: 'heavy' }],
    })
    expect(res.status).toBe(400)
    expect(
      res.data.errors.map((e: any) => `${e.row}:${e.code}`).sort(),
    ).toEqual(['0:not_null', '1:not_finite', '1:required'].sort())
  })

  test('a required column with no default cannot be omitted', async () => {
    const res = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: [{ weight: 1 }],
    })
    expect(res.data.errors.map((e: any) => e.code)).toContain('required')
  })
})

describe('bounds', () => {
  const oversized = (n: number) =>
    Array.from({ length: n }, () => ({ courier: 'dhl' }))

  test('over the insert bound is 413 with no statement executed', async () => {
    const res = await call('POST', '/api/_db/rows', {
      table: 'parcels',
      rows: oversized(LIMITS.insertRows + 1),
    })
    expect(res.status).toBe(413)
    expect(emitted()).toEqual([])
  })

  test('over the delete bound is 413 with no statement executed', async () => {
    const res = await call('DELETE', '/api/_db/rows', {
      table: 'parcels',
      keys: Array.from({ length: LIMITS.deleteKeys + 1 }, (_, i) => ({
        id: i,
      })),
    })
    expect(res.status).toBe(413)
    expect(emitted()).toEqual([])
  })

  test('over the bulk bound is 413 with no statement executed', async () => {
    const res = await call('POST', '/api/_db/rows/bulk', {
      table: 'parcels',
      edits: Array.from({ length: LIMITS.bulkEdits + 1 }, (_, i) => ({
        key: { id: i },
        set: { courier: 'x' },
      })),
    })
    expect(res.status).toBe(413)
    expect(emitted()).toEqual([])
  })

  test('over the import bound is 413 with no statement executed', async () => {
    const res = await call('POST', '/api/_db/import', {
      table: 'parcels',
      rows: oversized(LIMITS.csvRows + 1),
      onBadRow: 'stop',
    })
    expect(res.status).toBe(413)
    expect(emitted()).toEqual([])
  })

  test('over the lookup bound is 413', async () => {
    const res = await call('POST', '/api/_db/lookup', {
      refs: Array.from({ length: LIMITS.lookupRefs + 1 }, () => ({
        table: 'parcels',
        key: { id: 1 },
      })),
    })
    expect(res.status).toBe(413)
    expect(emitted()).toEqual([])
  })
})

describe('transactions and dry runs', () => {
  test('a bulk dry run runs the statements and then rolls back', async () => {
    const res = await call('POST', '/api/_db/rows/bulk', {
      table: 'parcels',
      edits: [
        { key: { id: 1 }, set: { courier: 'ups' } },
        { key: { id: 2 }, set: { courier: 'dpd' } },
      ],
      dryRun: true,
    })
    expect(res.status).toBe(200)
    expect(res.data.changed).toBe(2)
    // Executed — the report is about what the database actually did — and then
    // undone.
    expect(emitted().filter(s => s.startsWith('UPDATE')).length).toBe(2)
    expect(stub.tx.rolledBack).toBe(1)
    expect(stub.tx.committed).toBe(0)
  })

  test('a delete dry run rolls back too', async () => {
    const res = await call('DELETE', '/api/_db/rows', {
      table: 'parcels',
      keys: [{ id: 1 }],
      dryRun: true,
    })
    expect(res.status).toBe(200)
    expect(res.data.deleted).toBe(1)
    expect(stub.tx.rolledBack).toBe(1)
  })

  test('an import dry run rolls back', async () => {
    const res = await call('POST', '/api/_db/import', {
      table: 'parcels',
      rows: [{ courier: 'dhl' }],
      onBadRow: 'stop',
      dryRun: true,
    })
    expect(res.status).toBe(200)
    expect(res.data.inserted).toBe(1)
    expect(stub.tx.rolledBack).toBe(1)
  })

  test('a real bulk edit commits', async () => {
    const res = await call('POST', '/api/_db/rows/bulk', {
      table: 'parcels',
      edits: [{ key: { id: 1 }, set: { courier: 'ups' } }],
    })
    expect(res.status).toBe(200)
    expect(stub.tx.committed).toBe(1)
    expect(stub.tx.rolledBack).toBe(0)
  })

  test('one conflict rolls the whole bulk edit back — no partial apply', async () => {
    stub.state.changes = 0
    stub.state.row = null
    const res = await call('POST', '/api/_db/rows/bulk', {
      table: 'parcels',
      edits: [
        { key: { id: 1 }, set: { courier: 'ups' }, expect: { courier: 'dhl' } },
      ],
    })
    expect(res.status).toBe(409)
    expect(res.data.changed).toBe(0)
    expect(res.data.conflicts[0].index).toBe(0)
    expect(stub.tx.rolledBack).toBe(1)
    expect(stub.tx.committed).toBe(0)
  })
})

describe('import', () => {
  test('onBadRow: stop refuses the file with nothing executed', async () => {
    const res = await call('POST', '/api/_db/import', {
      table: 'parcels',
      rows: [{ courier: 'dhl' }, { courier: null }],
      onBadRow: 'stop',
    })
    expect(res.status).toBe(400)
    expect(emitted()).toEqual([])
  })

  test('onBadRow: skip imports the good rows and reports the rest', async () => {
    stub.state.changes = 1
    const res = await call('POST', '/api/_db/import', {
      table: 'parcels',
      rows: [{ courier: 'dhl' }, { courier: null }],
      onBadRow: 'skip',
    })
    expect(res.status).toBe(200)
    expect(res.data.skipped).toBe(1)
    expect(res.data.errors[0].code).toBe('not_null')
    expect(emitted().filter(s => s.startsWith('INSERT')).length).toBe(1)
  })

  test('onBadRow must be named — the default is not chosen for the caller', async () => {
    const res = await call('POST', '/api/_db/import', {
      table: 'parcels',
      rows: [{ courier: 'dhl' }],
    })
    expect(res.status).toBe(400)
    expect(res.message).toContain('onBadRow')
  })
})

describe('graph and lookup', () => {
  test('the graph carries identity and a label per table', async () => {
    const res = await call('GET', '/api/_db/graph')
    expect(res.status).toBe(200)
    expect(res.data.identity.parcels).toEqual({ mode: 'pk', cols: ['id'] })
    // The first non-identity text column — what a foreign-key chip shows.
    expect(res.data.labels.parcels).toBe('courier')
    expect(res.data.foreignKeys).toEqual({})
  })

  test('lookup batches into one statement per table, never one per ref', async () => {
    stub.state.row = { id: 1, courier: 'dhl' }
    const res = await call('POST', '/api/_db/lookup', {
      refs: [
        { table: 'parcels', key: { id: 1 } },
        { table: 'parcels', key: { id: 2 } },
        { table: 'parcels', key: { id: 3 } },
      ],
    })
    expect(res.status).toBe(200)
    expect(emitted().length).toBe(1)
    expect(emitted()[0]).toContain(' OR ')
    expect(res.data.rows.length).toBe(3)
    expect(res.data.rows[0].row).toEqual({ id: 1, courier: 'dhl' })
    // Ref 2 and 3 found nothing; they are nulls, not omissions.
    expect(res.data.rows[1].row).toBe(null)
  })
})
