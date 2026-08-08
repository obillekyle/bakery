export * from './adapters/base'

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

function getDriver(val?: string | null): 'sqlite' | 'postgres' | 'mysql' {
  const target = val?.trim() || ''
  if (!target) return 'sqlite'

  if (/^mysql[is]?:\/\//i.test(target)) return 'mysql'
  if (/^postgres(?:ql)?:\/\//i.test(target)) return 'postgres'
  if (isSQLite(target)) return 'sqlite'

  return 'postgres'
}

export async function createDbAdapter() {
  const url = process.env.DB_URL || process.env.DATABASE_URL || ''
  const driver = getDriver(url)
  const { poolOptionsFromEnv } = await import('./pool')
  // Read once and shared by both pooled drivers. SQLite takes none — it is a
  // single file handle with no pool to size.
  const pool = poolOptionsFromEnv()

  switch (driver) {
    case 'mysql': {
      const { MySQLAdapter } = await import('./adapters/mysql')
      return new MySQLAdapter(url || undefined, pool)
    }
    case 'postgres': {
      const { PGAdapter } = await import('./adapters/pgsql')
      return new PGAdapter(url || undefined, pool)
    }
    default: {
      const { SQLiteAdapter } = await import('./adapters/sqlite')
      return new SQLiteAdapter(url || undefined)
    }
  }
}
