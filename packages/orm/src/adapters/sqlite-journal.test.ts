import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { SQLiteAdapter } from './sqlite'

/**
 * The journal mode used to be picked by platform — `DELETE` on win32, `WAL`
 * everywhere else — for a reason nobody wrote down. It is now an attempt with
 * a checked fallback, and this is the end-to-end proof of the attempt half:
 * an ordinary file-backed database runs WAL.
 *
 * On win32 this test fails against the rule it replaces, which is the point.
 * The refusal half is pinned in core's `journal-mode.test.ts`, where the
 * function is reachable directly and a database that genuinely refuses WAL
 * can be handed to it.
 */
describe('SQLite journal mode', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(`${tmpdir()}/bakery-orm-journal-`)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a file-backed database runs WAL', async () => {
    const db = new SQLiteAdapter(`${dir}/t.db`)
    try {
      // The pragma chain is fire-and-forget behind the constructor, so wait
      // for it rather than sampling early. `close()` awaits the same promise.
      await db.query('SELECT 1').get()
      const row = (await db.query('PRAGMA journal_mode').get()) as {
        journal_mode: string
      } | null
      expect(row?.journal_mode.toLowerCase()).toBe('wal')
    } finally {
      await db.close?.()
    }
  })
})
