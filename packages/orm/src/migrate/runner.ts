import type { SQLAdapter } from '../adapters/base'
import { compareMigrations, type MigrationFile } from './files'
import {
  type ScriptDialect,
  scanStatements,
  transactionControl,
} from './script'

/**
 * Applied migrations, one row per file.
 *
 * Its own table, not a kind of row in `__bakery_schema`: that ledger holds
 * snapshots of a declared schema, which `db:rollback` replays by altering and
 * dropping, and a migration is a file that ran. `sync/ledger.ts` lists this
 * name among the tables classic sync never offers to drop.
 */
export const MIGRATIONS_TABLE = '__bakery_migrations'

export interface AppliedMigration {
  name: string
  checksum: string
  /** Unix seconds. */
  appliedAt: number
}

/** What a run will apply, and anything that stops it from applying at all. */
export interface MigrationPlan {
  pending: MigrationFile[]
  /** Empty when the run may go ahead. One problem anywhere stops every file. */
  problems: string[]
}

export interface PlanOptions {
  /** `adapter.transactionalDDL`: whether each file runs inside a transaction. */
  transactionalDDL: boolean
  dialect: ScriptDialect
}

/**
 * Compare the folder with the ledger.
 *
 * Fails closed: an applied file that changed or went missing, or a new file
 * that sorts before one that has run, refuses the whole run. Each of those
 * means the database and the folder no longer tell the same story, and
 * applying the rest on top would build on whichever one is wrong.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
  options: PlanOptions,
): MigrationPlan {
  const problems: string[] = []
  const byName = new Map(files.map(file => [file.name, file]))
  const ran = new Set(applied.map(row => row.name))

  for (const row of applied) {
    const file = byName.get(row.name)
    const on = new Date(row.appliedAt * 1000).toISOString().slice(0, 10)
    if (!file) {
      problems.push(
        `${row.name} ran on ${on} and is no longer in the folder. Put it back: the folder has to hold every migration that has run.`,
      )
    } else if (file.checksum !== row.checksum) {
      problems.push(
        `${row.name} changed after it ran on ${on}. Undo the edit, and write the change as a new migration.`,
      )
    }
  }

  const pending = files.filter(file => !ran.has(file.name))
  const last = files.filter(file => ran.has(file.name)).at(-1)
  for (const file of pending) {
    if (last && compareMigrations(file, last) < 0) {
      problems.push(
        `${file.name} sorts before ${last.name}, which has already run. Renumber it to sort after ${last.name}.`,
      )
    }
    problems.push(...fileProblems(file, options))
  }

  return { pending, problems }
}

/** What in one file's text would make the runner's handling of it unsafe. */
function fileProblems(file: MigrationFile, options: PlanOptions): string[] {
  // MySQL runs every file statement by statement with nothing to roll back,
  // so there is no transaction for a COMMIT to escape and no reason to hold a
  // no-transaction file to one statement.
  if (!options.transactionalDDL) return []

  if (!file.transaction) {
    const count = scanStatements(file.text, options.dialect).length
    return count === 1
      ? []
      : [
          `${file.name} runs outside a transaction, so it may hold one statement, and it holds ${count}. Move the others into a file of their own.`,
        ]
  }

  return transactionControl(file.text, options.dialect).map(
    statement =>
      `${file.name}, line ${statement.line}: ${statement.head} would end the transaction the file runs in and commit part of it. Remove it; each file is committed whole.`,
  )
}

/** A migration that failed, and whether anything of it stayed applied. */
export class MigrationError extends Error {
  constructor(
    readonly file: MigrationFile,
    readonly rolledBack: boolean,
    options: { cause: unknown },
  ) {
    const reason =
      options.cause instanceof Error
        ? options.cause.message
        : String(options.cause)
    super(
      `${file.name} failed: ${reason}. ${
        rolledBack
          ? 'Nothing in it was applied.'
          : 'It ran without a transaction, so statements before the failure stay applied. Check the database before running it again.'
      }`,
      options,
    )
    this.name = 'MigrationError'
  }
}

/** Create the ledger table when it is missing. */
export async function ensureLedger(adapter: SQLAdapter): Promise<void> {
  const q = (name: string) => adapter.quote(name)
  // Written out rather than through `colDef`: these four type names mean the
  // same thing on all three dialects, and `applied_at` is a BIGINT because
  // MySQL's INT is 32 bits and runs out in 2038.
  await adapter
    .query(
      `CREATE TABLE IF NOT EXISTS ${q(MIGRATIONS_TABLE)} (` +
        `${q('name')} VARCHAR(255) NOT NULL, ` +
        `${q('checksum')} VARCHAR(64) NOT NULL, ` +
        `${q('applied_at')} BIGINT NOT NULL, ` +
        `${q('duration_ms')} INTEGER NOT NULL, ` +
        `PRIMARY KEY (${q('name')}))`,
    )
    .run()
}

export async function readApplied(
  adapter: SQLAdapter,
): Promise<AppliedMigration[]> {
  const q = (name: string) => adapter.quote(name)
  const rows = (await adapter
    .query(
      `SELECT ${q('name')}, ${q('checksum')}, ${q('applied_at')} FROM ${q(MIGRATIONS_TABLE)}`,
    )
    .all()) as Record<string, unknown>[]
  return rows.map(row => ({
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: Number(row.applied_at ?? row.appliedAt),
  }))
}

async function recordApplied(
  adapter: SQLAdapter,
  file: MigrationFile,
  durationMs: number,
): Promise<void> {
  const q = (name: string) => adapter.quote(name)
  await adapter
    .query(
      `INSERT INTO ${q(MIGRATIONS_TABLE)} ` +
        `(${q('name')}, ${q('checksum')}, ${q('applied_at')}, ${q('duration_ms')}) VALUES (?, ?, ?, ?)`,
    )
    .run(file.name, file.checksum, Math.floor(Date.now() / 1000), durationMs)
}

/**
 * Apply `pending` in order, each file in a transaction of its own with its
 * ledger row inside it, where the dialect can roll DDL back. Stops at the first
 * failure: the files after it may depend on it.
 */
export async function applyMigrations(
  adapter: SQLAdapter,
  pending: MigrationFile[],
  onApplied?: (file: MigrationFile, durationMs: number) => void,
): Promise<void> {
  for (const file of pending) {
    const inTransaction = adapter.transactionalDDL && file.transaction
    const started = performance.now()
    let durationMs = 0
    try {
      if (inTransaction) {
        await adapter.transaction(async tx => {
          await tx.executeScript(file.text)
          durationMs = Math.round(performance.now() - started)
          await recordApplied(tx, file, durationMs)
        })
      } else {
        await adapter.executeScript(file.text)
        durationMs = Math.round(performance.now() - started)
        await recordApplied(adapter, file, durationMs)
      }
    } catch (cause) {
      throw new MigrationError(file, inTransaction, { cause })
    }
    onApplied?.(file, durationMs)
  }
}
