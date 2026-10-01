import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteAdapter } from './sqlite'

/**
 * A backup has to hold what the database holds, including what is still in
 * the write-ahead log.
 *
 * It was a copy of the main file, and in WAL mode (the default since the
 * journal-mode change) a commit lives in `-wal` until a checkpoint moves it
 * across, which SQLite does every 1,000 pages. A table created and filled
 * with 50 rows, then backed up, gave a file with no table in it at all. That
 * is the copy schema sync takes before a destructive migration.
 */
const dir = mkdtempSync(join(tmpdir(), 'bakery-backup-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('a backup taken in WAL mode holds every committed row', async () => {
  const db = new SQLiteAdapter(join(dir, 'app.db').replace(/\\/g, '/'))
  await db.query('CREATE TABLE t (v INTEGER)').run()
  for (let i = 0; i < 50; i++) await db.query('INSERT INTO t VALUES (?)').run(i)
  const mode = (await db.query('PRAGMA journal_mode').get()) as { journal_mode: string }
  expect(mode.journal_mode).toBe('wal')

  const result = await db.backup(5)
  await db.close()
  expect(result).not.toBeNull()

  const copy = new SQLiteAdapter(join(dir, 'backups', result!.file).replace(/\\/g, '/'))
  try {
    const row = await copy.query('SELECT count(*) AS n, sum(v) AS total FROM t').get()
    expect(row).toEqual({ n: 50, total: 1225 })
  } finally {
    await copy.close()
  }
})
