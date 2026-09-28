import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { Bakery } from '../core/bakery'
import { checkCacheVersion } from '../core/cache-version'
import { serveLog } from '../logger/serve-log'
import { fs } from '../utils'
import { Try } from '../utils/common/try'

/**
 * The tiered cache's spill-to-disk store: sessions and LRU overflow.
 *
 * Under `Bakery.dataDir`, beside `server.db`. Rows here are *rebuildable*: a
 * session is a cookie plus whatever the app hung off it, and the LRU tier
 * refills from source on the next miss, but rebuildable is not the same as
 * disposable-on-a-schedule, which is what living in `cacheDir` amounted to.
 * See the reversal below.
 *
 * **Sessions used to be wiped on every framework upgrade. They are not now, and
 * this paragraph is the reversal.**
 *
 * The file lived under `Bakery.cacheDir`, so `checkCacheVersion` deleted it on
 * every version bump and every dev<->prod switch: logging every user out. The
 * argument for that was sound: a cache format written by an older framework
 * must never be read by a newer one, and the version wipe is what guarantees
 * it.
 *
 * What changed is how often a version bumps. That reasoning was written when
 * releases were cut by hand and rare; releases are now computed from commit
 * messages and published automatically, so a patch ships whenever a `fix:`
 * lands. Logging out every user of every app on every patch is a far worse
 * trade than it was, and it was never the *goal*: only the consequence of
 * keying durability on a version number that had nothing to do with the stored
 * format.
 *
 * So the file moved to `Bakery.dataDir` and carries its own `SCHEMA_VERSION`.
 * The safety property is unchanged and now keyed on the thing that governs it:
 * a schema mismatch drops the tables, a framework bump does not.
 *
 * Two consequences worth knowing. An app with no ORM now creates a `bakery/`
 * directory where it previously created none: it is storing durable data, so
 * that is honest, but it means "no `bakery/` directory" is no longer evidence
 * that `initDB` never ran. And the LRU spill tier shares this file, so overflow
 * entries also survive; they are still rebuildable, just no longer discarded on
 * a schedule nobody chose.
 *
 * **The `await` below is what makes that true, and it must stay here.** This
 * module opens the database at *import* time, so running the check anywhere
 * else (it used to run from `initConfig()`) leaves the process holding a
 * handle inside the directory the wipe is about to delete. On Windows that
 * delete fails with `EBUSY`, node's recursive walk stops at the locked entry,
 * and whatever it had not reached yet survives. Awaiting here orders the two by
 * construction rather than by hoping one import happens after another.
 */
await checkCacheVersion()

/**
 * Bumped only when the *shape* of what is stored here changes.
 *
 * This is what replaced "wipe on every framework version". A schema change is
 * rare and deliberate; a framework patch is neither, and tying the two together
 * meant every patch logged out every user.
 */
const SCHEMA_VERSION = 1

const dbFilePath = `${Bakery.dataDir}/sessions.db`
if (!fs.exists(dbFilePath)) await fs.mkdir(dirname(dbFilePath))

export const cacheDb = new Database(dbFilePath, { create: true })

/**
 * Drop everything if the stored schema version is not this one.
 *
 * The safety property the cache wipe provided (a newer framework never reads
 * an older format) is preserved exactly, just keyed on the thing that actually
 * governs compatibility. A mismatch logs users out, which is the same outcome
 * as before; the difference is that it now happens when the format changes
 * rather than when any version number does.
 */
cacheDb.run('CREATE TABLE IF NOT EXISTS __schema (version INTEGER NOT NULL)')
const stored = cacheDb
  .query<{ version: number }, []>('SELECT version FROM __schema LIMIT 1')
  .get()

if (!stored) {
  cacheDb.run('INSERT INTO __schema (version) VALUES (?)', [SCHEMA_VERSION])
} else if (stored.version !== SCHEMA_VERSION) {
  const tables = cacheDb
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '__schema'",
    )
    .all()
  for (const { name } of tables) cacheDb.run(`DROP TABLE IF EXISTS "${name}"`)
  cacheDb.run('UPDATE __schema SET version = ?', [SCHEMA_VERSION])
}
/**
 * **WAL first, DELETE only where WAL is actually refused.**
 *
 * This was `process.platform === 'win32' ? 'DELETE' : 'WAL'`, a rule whose
 * reason was never written down. The standing hypothesis was that a Windows
 * network path cannot host WAL, and that much is true: WAL needs a shared
 * `-shm` mapping, which SMB and WebDAV do not provide. The rule was wrong in
 * its scope rather than its premise. It applied to every Windows install,
 * including the ordinary case of a local disk where WAL works perfectly.
 *
 * The cost of being wrong was paid on the request path, because sessions
 * write there. Measured on this machine, four interleaved rounds with a
 * CPU-bound control that stayed flat at 29-34 ms:
 *
 *     single autocommit write    DELETE 3629 us    WAL 36 us      100x
 *     100-row transaction        DELETE 3.91 ms    WAL 0.13 ms     29x
 *
 * So the rule is replaced by an attempt and a check, which is what makes it
 * safe to change without knowing why it was there. SQLite refuses WAL in
 * exactly two observable ways, and both are handled here:
 *
 *   - it **returns the unchanged mode** in the pragma's own result row, which
 *     is what an in-memory or anonymous-temp database does (`memory`); and
 *   - it **throws**, which is what a read-only database does.
 *
 * Measured, not assumed: both shapes were reproduced before this was written.
 * A pragma that silently did nothing would make the fallback unsafe, and it
 * does not - the returned row is the authority, so a filesystem that cannot
 * host WAL lands on DELETE and says so once instead of being guessed at in
 * advance.
 *
 * Returning the effective mode rather than the requested one matters for the
 * same reason: the log line has to name what the database is actually doing.
 *
 * Exported as a test seam rather than driven through the module's own
 * import-time call: this file opens the real cache database when it loads, so
 * the only way to assert on a *refusal* is to hand the function a database
 * that produces one. `:memory:` is such a case and is what the test uses.
 */
export function applyJournalMode(db: Database, file: string): string {
  const asked = Try.return(
    () =>
      db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode = WAL;')
        .get()?.journal_mode ?? '',
    (error: Error) => `threw: ${error.message}`,
  )
  if (asked.toLowerCase() === 'wal') return 'wal'

  // Wrapped as well. A database that refuses WAL by throwing will refuse the
  // fallback the same way when the mode it is already in is not DELETE, and
  // an unopenable cache is a far worse outcome than an untuned one.
  const fell = Try.return(
    () =>
      db
        .query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE;')
        .get()?.journal_mode ?? 'unknown',
    () =>
      db.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get()
        ?.journal_mode ?? 'unknown',
  )
  serveLog.JOURNAL_WAL_REFUSED({
    file,
    answer: asked || '(no row)',
    mode: fell,
  })
  return fell
}

applyJournalMode(cacheDb, dbFilePath)
cacheDb.run('PRAGMA synchronous = NORMAL;')
cacheDb.run('PRAGMA temp_store = memory;')
// `core/init.ts` installs THREAD_WORKER as an accessor holding a **boolean**,
// so the string comparison this used to carry (`!== 'false'`) was always true
// and the flag worked by accident. Read it through `import.meta.env`, which is
// where every other mode flag is read from.
const isWorker = Boolean(import.meta.env.THREAD_WORKER)
cacheDb.run(`PRAGMA cache_size = ${isWorker ? -256 : -2000};`)
cacheDb.run('PRAGMA busy_timeout = 5000;')
cacheDb.run('PRAGMA mmap_size = 0;')
