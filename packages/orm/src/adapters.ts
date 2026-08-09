export * from './adapters/base'
export * from './adapters/registry'

import { registerAdapter, resolveAdapter } from './adapters/registry'

/**
 * Does this target name a SQLite file rather than a server?
 *
 * Deliberately greedy — anything with a path separator lands here — because it
 * is consulted only *after* every registered scheme has had its say. Before
 * the registry that ordering was implicit and this heuristic ran second by
 * luck; now `protocols` is checked first by contract, so an adapter that
 * declares `mssql://` gets it even though this would happily have claimed it.
 */
function isSQLite(val: string) {
  return (
    val === ':memory:' ||
    val.startsWith('sqlite:') ||
    val.startsWith('file:') ||
    /(^|[\\/])[^\\/]+\\.db($|[?#])/i.test(val) ||
    val.endsWith('.db') ||
    val.includes('/') ||
    val.includes('\\')
  )
}

/**
 * The three built-in adapters, registered at module load.
 *
 * Registering is cheap — three object literals — because `open` is what pulls
 * the driver in. An app on SQLite never loads `mysql.ts` or `pgsql.ts`, which
 * was true of the `switch` this replaced and had to stay true of the registry.
 */
registerAdapter({
  driver: 'sqlite',
  protocols: ['sqlite', 'file'],
  matches: isSQLite,
  async open(target) {
    const { SQLiteAdapter } = await import('./adapters/sqlite')
    return new SQLiteAdapter(target || undefined)
  },
})

registerAdapter({
  driver: 'postgres',
  protocols: ['postgres', 'postgresql'],
  async open(target, pool) {
    const { PGAdapter } = await import('./adapters/pgsql')
    return new PGAdapter(target || undefined, pool)
  },
})

registerAdapter({
  driver: 'mysql',
  // Four spellings, all of which the adapter rewrites to `mysql://` in its
  // constructor: `mysqli`/`mysqlis` are PHP-era, `mysqls` is the TLS form.
  protocols: ['mysql', 'mysqls', 'mysqli', 'mysqlis'],
  async open(target, pool) {
    const { MySQLAdapter } = await import('./adapters/mysql')
    return new MySQLAdapter(target || undefined, pool)
  },
})

export async function createDbAdapter() {
  const url = process.env.DB_URL || process.env.DATABASE_URL || ''
  const { poolOptionsFromEnv } = await import('./pool')
  // Read once and handed to every adapter. SQLite ignores it — a single file
  // handle has no pool to size — but the registry cannot know which does what,
  // so the option goes to all of them and each takes what it needs.
  const pool = poolOptionsFromEnv()
  return await resolveAdapter(url).open(url || undefined, pool)
}
