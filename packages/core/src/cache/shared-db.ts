import { Database } from 'bun:sqlite'
import { dirname } from 'node:path'
import { Bakery } from '../core/bakery'
import { fs } from '../utils'

const dbFilePath = `${Bakery.dataDir}/shared-cache.db`
if (!fs.exists(dbFilePath)) await fs.mkdir(dirname(dbFilePath))

export const cacheDb = new Database(dbFilePath, { create: true })
const journalMode = process.platform === 'win32' ? 'DELETE' : 'WAL'
cacheDb.run(`PRAGMA journal_mode = ${journalMode};`)
cacheDb.run('PRAGMA synchronous = NORMAL;')
cacheDb.run('PRAGMA temp_store = memory;')
const isWorker = Boolean(
  process.env.THREAD_WORKER && process.env.THREAD_WORKER !== 'false',
)
cacheDb.run(`PRAGMA cache_size = ${isWorker ? -256 : -2000};`)
cacheDb.run('PRAGMA busy_timeout = 5000;')
cacheDb.run('PRAGMA mmap_size = 0;')
