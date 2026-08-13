import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { createStubDb } from '../test-fixtures'
import { handleExecuteAction, handleQuery } from './database'

const ACTION_URL = 'http://localhost/api/_dashboard/execute-action'
const TABLE = 'nonexistent_table_write_gate'

const { db: stubDb, calls: dbCalls, reset: resetDbCalls } = createStubDb()

// Saved because `afterEach` below *deletes* the variable: without this the
// suite would strip an operator's ambient DASHBOARD_ALLOW_WRITES from the
// process for every test file loaded after it.
const priorAllowWrites = process.env.DASHBOARD_ALLOW_WRITES

beforeAll(() => {
  __setTestDb(stubDb)
})

afterAll(() => {
  __resetTestDb()
  if (priorAllowWrites === undefined) delete process.env.DASHBOARD_ALLOW_WRITES
  else process.env.DASHBOARD_ALLOW_WRITES = priorAllowWrites
})

afterEach(() => {
  resetDbCalls()
  delete process.env.DASHBOARD_ALLOW_WRITES
})

function actionRequest(body: Record<string, unknown>) {
  return new Request(ACTION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * `DASHBOARD_ALLOW_WRITES` used to gate only `handleQuery`, so `DELETE FROM t`
 * typed into the SQL box was refused while the grid's Delete and Truncate
 * buttons — the same rows, reached through `execute-action` — were not. Both
 * deployment checklists tell operators that leaving the flag unset keeps the
 * console read-only; that was only ever true of one of its two write paths.
 */
describe('dashboard write gate', () => {
  test('truncate is refused with the flag unset', async () => {
    const res = await handleExecuteAction(
      actionRequest({ action: 'truncate', tableName: TABLE }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
    expect(res.message).toContain('DASHBOARD_ALLOW_WRITES')
  })

  test('row deletion is refused with the flag unset', async () => {
    const res = await handleExecuteAction(
      actionRequest({ action: 'delete-row', tableName: TABLE, rowid: 1 }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
  })

  test('row insertion is refused with the flag unset', async () => {
    const res = await handleExecuteAction(
      actionRequest({ action: 'insert-row', tableName: TABLE, row: { a: 1 } }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
  })

  test('the flag set to 1 lets the action through', async () => {
    process.env.DASHBOARD_ALLOW_WRITES = '1'
    const res = await handleExecuteAction(
      actionRequest({ action: 'truncate', tableName: TABLE }),
    )

    expect(dbCalls).toEqual([`truncate:${TABLE}`])
    expect(res.status).toBe(200)
  })

  test('any other value is not an opt-in', async () => {
    process.env.DASHBOARD_ALLOW_WRITES = 'true'
    const res = await handleExecuteAction(
      actionRequest({ action: 'truncate', tableName: TABLE }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
  })

  /**
   * The gate was bypassable, and these are the ways. `sql-classify.test.ts`
   * covers the classifier itself exhaustively; these assert the endpoint
   * actually consults it — the classifier being right is no use if
   * `handleQuery` still runs its own prefix test.
   *
   * `dbCalls` being empty is the real assertion in each. A 403 with the query
   * already executed would be a pass on status alone.
   */
  test.each([
    ['a CTE laundering a DELETE', 'WITH x AS (SELECT 1) DELETE FROM users'],
    ['a data-modifying CTE', 'WITH x AS (INSERT INTO t VALUES (1)) SELECT 1'],
    ['PRAGMA writable_schema', 'PRAGMA writable_schema = ON'],
    ['a second statement', 'SELECT 1; DROP TABLE users'],
    ['EXPLAIN ANALYZE', 'EXPLAIN ANALYZE DELETE FROM users'],
  ])('%s is refused with the flag unset', async (_name, sql) => {
    const res = await handleQuery(
      new Request('http://localhost/api/_dashboard/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql }),
      }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
  })

  test('ATTACH is refused even when writes are enabled', async () => {
    // Enabling writes says "this console may change my data". It does not say
    // "this console may write files to my host", which is what ATTACH plus
    // VACUUM INTO amounts to on SQLite.
    process.env.DASHBOARD_ALLOW_WRITES = '1'
    const res = await handleQuery(
      new Request('http://localhost/api/_dashboard/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: "ATTACH DATABASE 'evil.db' AS e" }),
      }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
    expect(res.message).toContain('ATTACH')
  })

  test('the SQL console keeps its own half of the same gate', async () => {
    const res = await handleQuery(
      new Request('http://localhost/api/_dashboard/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: `DELETE FROM ${TABLE}` }),
      }),
    )

    expect(dbCalls).toEqual([])
    expect(res.status).toBe(403)
  })

  test('reads are unaffected by the gate', async () => {
    const res = await handleQuery(
      new Request('http://localhost/api/_dashboard/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: `SELECT 1` }),
      }),
    )

    expect(dbCalls).toEqual(['all:SELECT 1'])
    expect(res.status).toBe(200)
  })
})
