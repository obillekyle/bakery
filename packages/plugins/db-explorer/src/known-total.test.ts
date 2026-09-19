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
import {
  __resetTestAccess,
  __setTestAccess,
  DbExplorerHandler,
} from './setup'

/**
 * Reading a page ran a `COUNT(*)` every time, including page 2 and beyond.
 * Measured on a 200,000-row SQLite table with a page size of 50, reading page
 * 101: the count is 11.7 ms unfiltered and 51.3 ms filtered, against 0.4 ms
 * and 1.6 ms for the rows themselves. 97% of the work either way.
 *
 * A caller that already counted can say so. What is asserted here is which
 * options reach the adapter, because that is the decision - a duration would
 * be flaky and would not say whether the count was skipped.
 */
function createStub() {
  const seen: Record<string, unknown>[] = []
  const db: any = {
    quoteChar: '"',
    maxQueryParams: 32766,
    schemaFingerprint: async () => 'stub:total:1',
    getSchema: async () => [
      {
        name: 'parcels',
        rowCount: null,
        columns: [
          { name: 'id', type: 'INTEGER', notnull: true, pk: true },
          { name: 'courier', type: 'TEXT', notnull: true, pk: false },
        ],
      },
    ],
    getConstraints: async () => ({
      parcels: {
        id: {
          type: 'integer',
          primary: true,
          nullable: false,
          autoIncrement: true,
        },
        courier: { type: 'string', nullable: false },
      },
    }),
    getIndexes: async () => ({}),
    getData: async (_table: string, options: Record<string, unknown>) => {
      seen.push(options)
      return {
        rows: [],
        totalRows: 4242,
        page: options.page,
        pageSize: options.pageSize,
        totalPages: 85,
      }
    },
    query: () => ({
      run: async () => ({ changes: 0, lastInsertRowid: 0 }),
      all: async () => [],
      get: async () => null,
    }),
    execute: { run: async () => ({ changes: 0 }), all: async () => [], get: async () => null },
  }
  return { db, seen }
}

const stub = createStub()

beforeAll(async () => {
  await initConfig()
  __setTestDb(stub.db)
})

afterAll(() => {
  __resetTestDb()
  __resetTestAccess()
})

beforeEach(() => {
  stub.seen.length = 0
  __setTestAccess({ authorize: () => 'read' })
})

async function read(query: string): Promise<any> {
  const path = `/api/_db/table-data${query}`
  const req = new Request(`http://localhost${path}`, {
    headers: { origin: 'http://localhost' },
  })
  return await DbExplorerHandler.handle(path, req)
}

describe('a page can reuse a total the caller already has', () => {
  test('page 2 passes the total through', async () => {
    const res = await read('?tableName=parcels&page=2&knownTotal=4242')
    expect(res.status).toBe(200)
    expect(stub.seen[0]!.knownTotal).toBe(4242)
  })

  test('page 1 always counts for real', async () => {
    // What makes a stale total self-correcting: every listing starts here,
    // and changing a filter restarts at page 1.
    const res = await read('?tableName=parcels&page=1&knownTotal=4242')
    expect(res.status).toBe(200)
    expect(stub.seen[0]!.knownTotal).toBeUndefined()
  })

  test('a request with no page counts for real', async () => {
    await read('?tableName=parcels&knownTotal=4242')
    expect(stub.seen[0]!.knownTotal).toBeUndefined()
  })

  test('a negative or unparseable total is ignored, not passed on', async () => {
    // Degrading to the count is the safe direction; a negative total would
    // produce a negative page count, which is the class of bug the unbounded
    // `pageSize` already produced once.
    await read('?tableName=parcels&page=2&knownTotal=-5')
    expect(stub.seen[0]!.knownTotal).toBeUndefined()

    stub.seen.length = 0
    await read('?tableName=parcels&page=2&knownTotal=lots')
    expect(stub.seen[0]!.knownTotal).toBeUndefined()
  })

  test('zero is a real total and is passed through', async () => {
    // An empty filtered listing. `0` is falsy, so a truthiness check here
    // would quietly re-count every page of it.
    await read('?tableName=parcels&page=3&knownTotal=0')
    expect(stub.seen[0]!.knownTotal).toBe(0)
  })
})
