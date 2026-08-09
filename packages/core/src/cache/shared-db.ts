import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { Bakery } from '../core/bakery'
import { checkCacheVersion } from '../core/cache-version'
import { fs } from '../utils'

/**
 * The tiered cache's spill-to-disk store — sessions and LRU overflow.
 *
 * Under `Bakery.cacheDir`, not `dataDir`, because every row in it is
 * rebuildable: a session is a cookie plus whatever the app chose to hang off
 * it, and the LRU tier re-fills from source on the next miss. It used to sit
 * beside `server.db` in the data directory, which put a disposable file behind
 * the one durability guarantee the framework makes.
 *
 * **The consequence is that sessions do not survive a framework upgrade.**
 * `checkCacheVersion` wipes the whole cache directory on every version bump and
 * every dev<->prod switch, and this file goes with it — users are logged out.
 * That is intended: the alternative is a cache format from an older framework
 * version being read by a newer one, which is exactly the failure the version
 * wipe exists to prevent. Anything that must outlive an upgrade belongs in the
 * app's own tables under `Bakery.dataDir`.
 *
 * **That was aspirational until 2026-08-09, and the `await` below is what makes
 * it true.** The check ran from `initConfig()`, while this module opens the
 * database at *import* time — so the process already held a handle inside the
 * directory the wipe was about to delete. On Windows the delete failed with
 * `EBUSY`, node's recursive walk stopped at the locked entry, and whatever it
 * had not reached yet survived: sessions *did* outlive upgrades, and so did
 * `html/`, the compiled-page cache. Awaiting the check here orders the two by
 * construction — the cache cannot be opened before it has been validated —
 * rather than by hoping one import happens after another.
 */
await checkCacheVersion()

const dbFilePath = `${Bakery.cacheDir}/shared-cache.db`
if (!fs.exists(dbFilePath)) await fs.mkdir(dirname(dbFilePath))

export const cacheDb = new Database(dbFilePath, { create: true })
const journalMode = process.platform === 'win32' ? 'DELETE' : 'WAL'
cacheDb.run(`PRAGMA journal_mode = ${journalMode};`)
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
