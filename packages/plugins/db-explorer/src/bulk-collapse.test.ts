import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { __resetIntrospectCache } from './identity'
import { groupBulkEdits } from './endpoints/rows'
import {
  __resetTestAccess,
  __setTestAccess,
  DbExplorerHandler,
} from './setup'

/**
 * A bulk edit issued one `UPDATE` per row: 1,000 edits were 1,000 statements
 * plus the transaction and the conflict probes on top. Rows in a bulk edit
 * almost always share their `set` and their `expect` (that is what makes it a
 * bulk edit), so they collapse to one `UPDATE ... IN` per group.
 *
 * What is asserted here is the **statement count**, not a duration. A timing
 * assertion on two cores would be flaky and would not actually say whether the
 * collapse happened.
 */
const SCHEMA = [
  {
    name: 'parcels',
    rowCount: null,
    columns: [
      { name: 'id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'courier', type: 'TEXT', notnull: true, pk: false },
      { name: 'status', type: 'TEXT', notnull: false, pk: false },
    ],
  },
  {
    name: 'parcel_legs',
    rowCount: null,
    columns: [
      { name: 'parcel_id', type: 'INTEGER', notnull: true, pk: true },
      { name: 'leg_no', type: 'INTEGER', notnull: true, pk: true },
      { name: 'carrier', type: 'TEXT', notnull: true, pk: false },
    ],
  },
]

const CONSTRAINTS: any = {
  parcels: {
    id: { type: 'integer', primary: true, nullable: false, autoIncrement: true },
    courier: { type: 'string', nullable: false },
    status: { type: 'string', nullable: true },
  },
  parcelLegs: {
    parcelId: { type: 'integer', primary: true, nullable: false },
    legNo: { type: 'integer', primary: true, nullable: false },
    carrier: { type: 'string', nullable: false },
  },
}

function createStub() {
  const statements: { sql: string; params: unknown[] }[] = []
  const state = {
    /** Key values a probing SELECT should report as present. */
    present: new Set<unknown>(),
    /** What each UPDATE reports as changed. */
    changesPerUpdate: (chunk: number) => chunk,
  }

  const runResult = (sql: string) => {
    if (!/^\s*update/i.test(sql)) return { changes: 1, lastInsertRowid: 1 }
    const inList = sql.match(/IN \(([^)]*)\)/)
    const size = inList ? inList[1]!.split(',').length : 1
    return { changes: state.changesPerUpdate(size), lastInsertRowid: 1 }
  }

  const db: any = {
    quoteChar: '"',
    maxQueryParams: 32766,
    schemaFingerprint: async () => 'stub:collapse:1',
    getSchema: async () => SCHEMA,
    getConstraints: async () => CONSTRAINTS,
    getIndexes: async () => ({}),
    getData: async () => [],
    transaction: async (callback: (db: unknown) => Promise<unknown>) =>
      await callback(db),
    query: (sql: string) => ({
      run: async (...params: unknown[]) => {
        statements.push({ sql, params })
        return runResult(sql)
      },
      all: async (...params: unknown[]) => {
        statements.push({ sql, params })
        // A probing `SELECT <col> FROM t WHERE <col> IN (?, ?, …)` answers
        // with whichever of its bound values the test says are present.
        if (/^\s*select/i.test(sql)) {
          const column = sql.match(/SELECT "([^"]+)"/)?.[1]
          if (column) {
            return params
              .filter(value => state.present.has(value))
              .map(value => ({ [column]: value }))
          }
        }
        return []
      },
      get: async () => null,
    }),
    execute: {
      run: async (sql: string, params: unknown[]) => {
        statements.push({ sql, params })
        return runResult(sql)
      },
      all: async () => [],
      get: async () => null,
    },
  }

  return { db, statements, state }
}

const stub = createStub()

beforeAll(async () => {
  await initConfig()
  __setTestDb(stub.db)
})

afterAll(() => {
  __resetTestDb()
  __resetTestAccess()
  __resetIntrospectCache()
})

beforeEach(() => {
  stub.statements.length = 0
  stub.state.present = new Set()
  stub.state.changesPerUpdate = (chunk: number) => chunk
  __setTestAccess({ authorize: () => 'write' })
})

async function bulk(body: unknown): Promise<any> {
  const req = new Request('http://localhost/api/_db/rows/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost' },
    body: JSON.stringify(body),
  })
  return await DbExplorerHandler.handle('/api/_db/rows/bulk', req)
}

const updates = () =>
  stub.statements.filter(s => /^\s*update/i.test(s.sql)).map(s => s.sql)

describe('a bulk edit collapses into one statement per group', () => {
  test('200 rows sharing one set are one UPDATE, not 200', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1)
    stub.state.present = new Set(ids)

    const res = await bulk({
      table: 'parcels',
      edits: ids.map(id => ({ key: { id }, set: { courier: 'ups' } })),
    })

    expect(res.status).toBe(200)
    expect(res.data.changed).toBe(200)
    expect(updates().length).toBe(1)
    expect(updates()[0]).toMatch(/IN \(/)
  })

  test('two distinct sets are two statements, not one and not two hundred', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => i + 1)
    stub.state.present = new Set(ids)

    const res = await bulk({
      table: 'parcels',
      edits: ids.map(id => ({
        key: { id },
        set: { courier: id % 2 === 0 ? 'ups' : 'dhl' },
      })),
    })

    expect(res.status).toBe(200)
    expect(updates().length).toBe(2)
  })

  test('a shared expect goes into the same statement', async () => {
    const ids = [1, 2, 3, 4]
    stub.state.present = new Set(ids)

    await bulk({
      table: 'parcels',
      edits: ids.map(id => ({
        key: { id },
        set: { status: 'archived' },
        expect: { status: 'draft' },
      })),
    })

    expect(updates().length).toBe(1)
    // identity AND expect, exactly as the single-row path builds it.
    expect(updates()[0]).toMatch(/IN \(/)
    expect(updates()[0]).toMatch(/status/)
  })

  test('a member whose row moved on is named by its own edit index', async () => {
    const ids = [10, 11, 12, 13]
    // 12 has moved on since it was read.
    stub.state.present = new Set([10, 11, 13])

    const res = await bulk({
      table: 'parcels',
      edits: ids.map(id => ({
        key: { id },
        set: { courier: 'ups' },
        expect: { courier: 'dhl' },
      })),
    })

    expect(res.status).toBe(409)
    expect(res.data.conflicts.length).toBe(1)
    // Index 2 in the list the caller sent, not a position in a regrouped one.
    expect(res.data.conflicts[0].index).toBe(2)
    expect(res.data.conflicts[0].key).toEqual({ id: 12 })
    // Nothing was written: the probe runs before the update precisely so a
    // group with a conflict never writes something about to be rolled back.
    expect(updates().length).toBe(0)
    expect(res.data.changed).toBe(0)
  })

  test('a composite identity falls back to one statement per row', async () => {
    // `IN` addresses one column. Two-column keys take the path they always
    // took rather than being refused.
    const res = await bulk({
      table: 'parcel_legs',
      edits: [
        { key: { parcel_id: 1, leg_no: 1 }, set: { carrier: 'ups' } },
        { key: { parcel_id: 1, leg_no: 2 }, set: { carrier: 'ups' } },
      ],
    })

    expect(res.status).toBe(200)
    expect(updates().length).toBe(2)
    for (const sql of updates()) expect(sql).not.toMatch(/IN \(/)
  })

  test('a lone edit is not given a probe it does not need', async () => {
    const res = await bulk({
      table: 'parcels',
      edits: [{ key: { id: 1 }, set: { courier: 'ups' } }],
    })

    expect(res.status).toBe(200)
    expect(updates().length).toBe(1)
    expect(updates()[0]).not.toMatch(/IN \(/)
    // No `SELECT <col> ... IN` probe was issued for it.
    const probes = stub.statements.filter(
      s => /^\s*select/i.test(s.sql) && /IN \(/.test(s.sql),
    )
    expect(probes.length).toBe(0)
  })
})

describe('what disqualifies a member from a group', () => {
  const edit = (key: Record<string, unknown>, set: Record<string, unknown>) => ({
    key,
    set,
    expect: {},
  })

  test('a null key value is never put in an IN list', () => {
    // `IN` never matches NULL, and `IS NULL` is a different clause, so a
    // silent collapse here would turn an edit into a no-op. Unreachable
    // through the endpoint for a NOT NULL primary key, reachable for an
    // identity that is a unique index over a nullable column.
    const { collapsible, single } = groupBulkEdits([
      edit({ id: 1 }, { courier: 'ups' }),
      edit({ id: null }, { courier: 'ups' }),
      edit({ id: 2 }, { courier: 'ups' }),
    ])

    expect(collapsible.length).toBe(1)
    expect(collapsible[0]!.members.map(m => m.value)).toEqual([1, 2])
    expect(single).toEqual([1])
  })

  test('a composite identity is never collapsed', () => {
    const { collapsible, single } = groupBulkEdits([
      edit({ parcel_id: 1, leg_no: 1 }, { carrier: 'ups' }),
      edit({ parcel_id: 1, leg_no: 2 }, { carrier: 'ups' }),
    ])

    expect(collapsible.length).toBe(0)
    expect(single).toEqual([0, 1])
  })

  test('a group of one stays single', () => {
    const { collapsible, single } = groupBulkEdits([
      edit({ id: 1 }, { courier: 'ups' }),
      edit({ id: 2 }, { courier: 'dhl' }),
    ])

    expect(collapsible.length).toBe(0)
    expect(single).toEqual([0, 1])
  })

  test('leftovers come back in the order they were sent', () => {
    // They come out of a Map, which has lost the caller's order; the
    // transaction applies them in sequence, so it has to be restored.
    const { single } = groupBulkEdits([
      edit({ id: 1 }, { courier: 'a' }),
      edit({ parcel_id: 1, leg_no: 1 }, { carrier: 'x' }),
      edit({ id: 2 }, { courier: 'b' }),
      edit({ id: 3 }, { courier: 'c' }),
    ])

    expect(single).toEqual([0, 1, 2, 3])
  })

  test('members keep the index the caller gave them', () => {
    const { collapsible } = groupBulkEdits([
      edit({ parcel_id: 1, leg_no: 1 }, { carrier: 'x' }),
      edit({ id: 7 }, { courier: 'ups' }),
      edit({ id: 8 }, { courier: 'ups' }),
    ])

    expect(collapsible[0]!.members).toEqual([
      { index: 1, value: 7 },
      { index: 2, value: 8 },
    ])
  })
})
