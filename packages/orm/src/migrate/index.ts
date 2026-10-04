import { resolve } from 'node:path'
import { Logger, messageLogger } from '@bakery-framework/core/logger'
import { resolveAdapter, type SQLAdapter } from '../adapters'
import { type MigrationFile, readMigrations } from './files'
import {
  applyMigrations,
  ensureLedger,
  MigrationError,
  planMigrations,
  readApplied,
} from './runner'

export * from './files'
export * from './runner'
export {
  type ScriptDialect,
  scanStatements,
  transactionControl,
} from './script'

const logger = new Logger('db-migrate')

// prettier-ignore
export const migrateMsgs = {
  OFF: 'E Migrations are off. Set %ymigrations%* in server.config.ts to the folder that holds them.',
  PROBLEM: 'E {problem}',
  REFUSED:
    'E Nothing was applied. Fix the %y{count}%* problem(s) above, then run %ydb:migrate%* again.',
  UP_TO_DATE: 'I Up to date: %y{count}%* migration(s) have run.',
  PENDING: 'I %y{count}%* migration(s) to apply from %y{dir}%*:',
  PENDING_ITEM: 'I   %y{name}%*',
  APPLIED: 'I Applied %y{name}%* in %y{ms}%* ms.',
  DONE: 'I %gApplied {count} migration(s).%*',
  FAILED: 'E {message}',
} as const

export const MESSAGES = messageLogger(logger, migrateMsgs)

const HELP = `
Usage: bun run db:migrate [--status] [--help]

Applies the SQL files in the migrations folder (\`migrations\` in
server.config.ts) that have not run yet, in order, each in a transaction where
the database can roll DDL back (Postgres and SQLite; not MySQL).

Flags:
  --status   List what would run, and apply nothing.
  --help     This.

The connection is DB_MIGRATE_URL when it is set, so migrations can run as a
role that owns the schema while the app connects as one that does not. Without
it, DB_URL.
`

export interface MigrateResult {
  applied: string[]
  pending: string[]
  problems: string[]
}

/**
 * Read the folder, compare it with the ledger and, when `apply` is set and
 * nothing is wrong, apply what is pending. The migration lock is held from the
 * ledger read to the last file, so a second run started meanwhile waits and
 * then finds nothing to do.
 */
export async function runMigrations(
  adapter: SQLAdapter,
  dir: string,
  options: {
    apply: boolean
    onApplied?: (file: MigrationFile, durationMs: number) => void
  },
): Promise<MigrateResult> {
  const read = await readMigrations(dir)
  if (!read.ok) return { applied: [], pending: [], problems: read.problems }

  const release = await adapter.takeMigrationLock()
  try {
    await ensureLedger(adapter)
    const plan = planMigrations(read.files, await readApplied(adapter), {
      transactionalDDL: adapter.transactionalDDL,
      dialect: adapter.scriptDialect,
    })
    const pending = plan.pending.map(file => file.name)
    if (plan.problems.length || !options.apply) {
      return { applied: [], pending, problems: plan.problems }
    }

    const applied: string[] = []
    await applyMigrations(adapter, plan.pending, (file, durationMs) => {
      applied.push(file.name)
      options.onApplied?.(file, durationMs)
    })
    return { applied, pending, problems: [] }
  } finally {
    await release()
  }
}

/**
 * The connection `db:migrate` uses: `DB_MIGRATE_URL`, then the app's own.
 * Opened with a pool of one, because the migration lock belongs to a session
 * and every statement has to run on the session that holds it.
 */
export async function openMigrationAdapter(): Promise<SQLAdapter> {
  const url =
    process.env.DB_MIGRATE_URL ||
    process.env.DB_URL ||
    process.env.DATABASE_URL ||
    ''
  return await resolveAdapter(url).open(url || undefined, { max: 1 })
}

/** `bun run db:migrate`. Returns the exit code rather than exiting. */
export async function migrate(
  argv: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    // Usage text is program output, not a log line, as in `db:sync --help`.
    console.log(HELP)
    return 0
  }

  const { initConfig } = await import('@bakery-framework/core/core/config')
  const config = await initConfig()
  if (!config.migrations) {
    MESSAGES.OFF()
    return 1
  }

  const dir = resolve(cwd, config.migrations)
  const apply = !argv.includes('--status')
  const adapter = await openMigrationAdapter()
  try {
    const result = await runMigrations(adapter, dir, {
      apply,
      onApplied: (file, ms) => MESSAGES.APPLIED({ name: file.name, ms }),
    })

    if (result.problems.length) {
      for (const problem of result.problems) MESSAGES.PROBLEM({ problem })
      MESSAGES.REFUSED({ count: result.problems.length })
      return 1
    }
    if (!result.pending.length) {
      const ran = (await readApplied(adapter)).length
      MESSAGES.UP_TO_DATE({ count: ran })
      return 0
    }
    if (!apply) {
      MESSAGES.PENDING({ count: result.pending.length, dir })
      for (const name of result.pending) MESSAGES.PENDING_ITEM({ name })
      return 0
    }
    MESSAGES.DONE({ count: result.applied.length })
    return 0
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error
    MESSAGES.FAILED({ message: error.message })
    return 1
  } finally {
    await adapter.close()
  }
}

if (import.meta.main) process.exit(await migrate())
