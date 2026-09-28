import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { applyJournalMode } from './shared-db'

/**
 * The journal mode used to be chosen by platform (`DELETE` on win32, `WAL`
 * everywhere else), with no recorded reason. These pin the replacement: try
 * WAL, detect a refusal, fall back.
 *
 * Both assertions fail against the rule they replace. On win32 the first one
 * saw `delete` where it now sees `wal`; the second could not exist at all,
 * because the old code never read the pragma's answer back and so had no way
 * to tell a refusal from a success.
 */
describe('journal mode', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(`${tmpdir()}/bakery-journal-`)
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('takes WAL on a file database, on every platform', () => {
    const db = new Database(`${dir}/wal.db`)
    try {
      expect(applyJournalMode(db, `${dir}/wal.db`)).toBe('wal')
      // Not just the return value: what the database is actually running.
      const live = db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode;')
        .get()
      expect(live?.journal_mode.toLowerCase()).toBe('wal')
    } finally {
      db.close()
    }
  })

  test('detects a refusal and reports the mode actually in force', () => {
    // An in-memory database cannot run WAL: SQLite answers the pragma with
    // the unchanged mode rather than throwing, which is the harder of the two
    // refusal shapes to notice and the reason the answer is read back.
    const db = new Database(':memory:')
    try {
      const mode = applyJournalMode(db, ':memory:')
      expect(mode).not.toBe('wal')
      // The value returned is the effective mode, not the requested one, a
      // log line naming a mode the database is not running would be worse
      // than no line.
      const live = db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode;')
        .get()
      expect(mode).toBe(live?.journal_mode ?? '')
    } finally {
      db.close()
    }
  })

  test('a refusal that throws is caught rather than killing the open', () => {
    // The other refusal shape. A read-only database rejects the pragma with
    // "attempt to write a readonly database"; the open must survive it.
    const file = `${dir}/ro.db`
    new Database(file, { create: true }).close()
    const db = new Database(file, { readonly: true })
    try {
      expect(() => applyJournalMode(db, file)).not.toThrow()
    } finally {
      db.close()
    }
  })
})
