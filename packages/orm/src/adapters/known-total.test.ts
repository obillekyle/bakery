import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SQLiteAdapter } from './sqlite'

/**
 * A page's `COUNT(*)` is almost all of its cost. Measured on a 200,000-row
 * SQLite table with a page size of 50, reading page 101:
 *
 *     count, no filter    11.7 ms      rows, no filter    0.4 ms
 *     count, filtered     51.3 ms      rows, filtered     1.6 ms
 *
 * A caller that already counted can hand the total back. What is asserted
 * here is that the number is honoured and that a bad one falls back, because
 * the wrong behaviour is silent: a total that is ignored is merely slow, and
 * one that is trusted when it should not be is a wrong page count.
 */
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // WAL sidecars linger a moment on Windows; these are temp directories.
    }
  }
})

async function seeded(rows: number): Promise<SQLiteAdapter> {
  const dir = mkdtempSync(`${tmpdir()}/total-`)
  dirs.push(dir)
  const db = new SQLiteAdapter(`${dir}/a.db`)
  await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, tag TEXT)').run()
  await db.transaction(async () => {
    for (let i = 1; i <= rows; i++) {
      await db.query('INSERT INTO t (id, tag) VALUES (?, ?)').run(i, i % 2 ? 'a' : 'b')
    }
  })
  return db
}

describe('getData honours a caller-supplied total', () => {
  test('without one it counts, and the count is right', async () => {
    const db = await seeded(30)
    const page = await db.getData('t', { page: 1, pageSize: 10 })
    expect(page.totalRows).toBe(30)
    expect(page.totalPages).toBe(3)
    expect(page.rows.length).toBe(10)
    await db.close()
  })

  test('a supplied total is used in place of the count', async () => {
    const db = await seeded(30)
    // Deliberately not 30: if the adapter counted, this would come back as 30
    // and the assertion would fail. Asserting the wrong number is the only way
    // to prove the right query was skipped.
    const page = await db.getData('t', { page: 2, pageSize: 10, knownTotal: 999 })
    expect(page.totalRows).toBe(999)
    expect(page.totalPages).toBe(100)
    // The rows themselves are unaffected, which is the whole safety argument.
    expect(page.rows.length).toBe(10)
    await db.close()
  })

  test('zero is a total, not a missing one', async () => {
    const db = await seeded(30)
    const page = await db.getData('t', { page: 1, pageSize: 10, knownTotal: 0 })
    expect(page.totalRows).toBe(0)
    await db.close()
  })

  test('a negative or non-finite total falls back to counting', async () => {
    const db = await seeded(30)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const page = await db.getData('t', {
        page: 1,
        pageSize: 10,
        knownTotal: bad,
      })
      expect(page.totalRows).toBe(30)
    }
    await db.close()
  })

  test('usableTotal is the one rule all three adapters ask', () => {
    expect(SQLiteAdapter.usableTotal(0)).toBe(true)
    expect(SQLiteAdapter.usableTotal(42)).toBe(true)
    expect(SQLiteAdapter.usableTotal(-1)).toBe(false)
    expect(SQLiteAdapter.usableTotal(Number.NaN)).toBe(false)
    expect(SQLiteAdapter.usableTotal(Number.POSITIVE_INFINITY)).toBe(false)
    expect(SQLiteAdapter.usableTotal(undefined)).toBe(false)
    expect(SQLiteAdapter.usableTotal('7')).toBe(false)
  })
})
