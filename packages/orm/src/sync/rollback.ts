import '@bakery/core/core/init'

import { Logger, messageLogger } from '@bakery/core/logger'
import type { SQLAdapter } from '../adapters/base'
import { SchemaBuilder } from './builder'
import { MESSAGES as SYNC_MESSAGES, SyncEngine } from './engine'
import { type LedgerEntry, readLedgerEntries } from './ledger'
import { loadSchema, schemaFromConfig } from './load'
import type * as SyncTypes from './types'

const logger = new Logger('db-rollback')

// prettier-ignore
const rollbackMsgs = {
  NO_HISTORY:
    'E %rNothing to roll back to%*: this database has no schema history. The ledger fills up as %ydb:sync%* applies changes, so there is nothing recorded before the current state.',
  ONLY_ONE:
    'E %rNothing to roll back to%*: only one schema has ever been applied (#{id}). A rollback needs a previous state to restore.',
  NO_SUCH_ENTRY:
    'E %rNo schema #{id} in this database’s history%*. Run %ydb:history%* to see what is there.',
  IS_CURRENT:
    'E %rSchema #{id} is already the current one%*. Rolling back to it would do nothing.',
  TARGET:
    'I Rolling back to schema %y#{id}%* ({when} UTC), applied {steps} change(s) ago.',
  NO_INDEX_RECORD:
    'W %ySchema #{id} predates the ledger recording indexes%*, so this rollback leaves indexes exactly as they are. Tables and columns roll back; index changes made since then do not.',
  SCHEMA_REWRITTEN:
    'I Rewrote %y{path}%* to match the restored schema.',
  SCHEMA_KEPT:
    'W %y--keep-schema: schema.ts still describes the newer schema.%* The next %ydb:sync%* — including the one a dev boot runs — will apply it again and undo this rollback. Revert the file yourself, or re-run without the flag.',
  DONE: 'I %gRollback complete%*.',
} as const

const MESSAGES = messageLogger(logger, rollbackMsgs)

/**
 * Which recorded schema to restore.
 *
 * Default is one step back, which is what "roll back" means with no argument.
 * `entries` is newest first, so index 1 is the previous state and index 0 is
 * where we are now.
 */
export function pickTarget(
  entries: LedgerEntry[],
  toId?: number,
):
  | { ok: true; target: LedgerEntry; steps: number }
  | { ok: false; code: keyof typeof rollbackMsgs; id?: number } {
  if (!entries.length) return { ok: false, code: 'NO_HISTORY' }
  if (toId === undefined) {
    if (entries.length < 2)
      return { ok: false, code: 'ONLY_ONE', id: entries[0]!.id }
    return { ok: true, target: entries[1]!, steps: 1 }
  }
  const index = entries.findIndex(e => e.id === toId)
  if (index < 0) return { ok: false, code: 'NO_SUCH_ENTRY', id: toId }
  if (index === 0) return { ok: false, code: 'IS_CURRENT', id: toId }
  return { ok: true, target: entries[index]!, steps: index }
}

export class RollbackService {
  protected constructor() {}

  static helpRequested(argv: string[] = process.argv.slice(2)): boolean {
    return argv.includes('--help') || argv.includes('-h')
  }

  static printHelp(): void {
    console.log(`
Usage: bun run db:rollback [--to=<id>] [--dry-run] [--force-sync] [--keep-schema]

Restores a schema this database previously had. The state is read from the
ledger Bakery writes on every sync, so there are no migration files and no
hand-written down-migrations.

Flags:
  --to=<id>       Roll back to a specific schema (see db:history). Default is
                  one step back.
  --dry-run       Preview the changes without applying them
  --force-sync    In production, allow destructive changes
  --keep-schema   Do not rewrite schema.ts. The next sync will undo the
                  rollback -- see the warning it prints.
  --help, -h      Show this help message

A rollback is a migration like any other: it can drop columns, and dropping a
column drops its data. It takes a backup first and asks before destructive
changes, exactly as db:sync does.
`)
  }

  /** `--to=12`, or undefined. A non-numeric value is treated as absent. */
  static parseTo(argv: string[] = process.argv.slice(2)): number | undefined {
    const raw = argv.find(a => a.startsWith('--to='))?.slice('--to='.length)
    if (raw === undefined) return undefined
    const n = Number(raw)
    return Number.isInteger(n) ? n : undefined
  }

  static async run(): Promise<void> {
    if (RollbackService.helpRequested()) return RollbackService.printHelp()

    const { initConfig } = await import('@bakery/core/core/config')
    const { closeDB, connection, initDB } = await import('../connection')
    const config = await initConfig()
    await initDB()

    const entries = await readLedgerEntries(connection)
    const picked = pickTarget(entries, RollbackService.parseTo())
    if (!picked.ok) {
      // Switched rather than indexed: `MESSAGES[code]` types as the
      // intersection of every message's parameters, so it demands `when` and
      // `steps` from a message that has neither.
      const id = picked.id ?? 0
      if (picked.code === 'NO_HISTORY') MESSAGES.NO_HISTORY()
      else if (picked.code === 'ONLY_ONE') MESSAGES.ONLY_ONE({ id })
      else if (picked.code === 'NO_SUCH_ENTRY') MESSAGES.NO_SUCH_ENTRY({ id })
      else MESSAGES.IS_CURRENT({ id })
      await closeDB()
      return process.exit(1)
    }

    const { target, steps } = picked
    const { formatWhen } = await import('./history')
    MESSAGES.TARGET({
      id: target.id,
      when: formatWhen(target.appliedAt),
      steps,
    })

    // A v1 row recorded no indexes, and replaying it with an empty index set
    // would read as "drop every index" — a silent, permanent performance
    // change dressed up as a rollback. Restoring the *live* indexes instead
    // means the plan contains no index work at all, which is the honest
    // degradation: it does less than asked, and says so.
    let indexes: SyncTypes.DBIndexes
    if (target.indexes === undefined) {
      MESSAGES.NO_INDEX_RECORD({ id: target.id })
      indexes = await connection.getIndexes()
    } else {
      indexes = target.indexes
    }

    // Only for the path and layout. The constraints in schema.ts describe where
    // we are now, which is precisely what a rollback is leaving behind.
    const loaded = await loadSchema(process.cwd(), schemaFromConfig(config))

    await RollbackService.apply(
      connection,
      target,
      indexes,
      loaded.targetPath,
      loaded.layout,
    )
    await closeDB()
  }

  private static async apply(
    adapter: SQLAdapter,
    target: LedgerEntry,
    indexes: SyncTypes.DBIndexes,
    schemaPath: string,
    layout: Parameters<typeof SchemaBuilder.generate>[4],
  ): Promise<void> {
    // The whole point of the ledger: a rollback is just a sync whose target is
    // a schema we already stored. Backups, the destructive-change prompt,
    // `--dry-run`, `--force-sync` and the new ledger row all come from
    // `SyncEngine.run` unchanged — there is no second migration path to keep
    // correct, which is the only reason this file is as short as it is.
    await SyncEngine.run(
      adapter,
      target.constraints,
      indexes,
      schemaPath,
      layout,
    )

    if (process.argv.includes('--dry-run')) return

    // Without this the rollback is undone by the next thing that syncs, and a
    // dev boot syncs. schema.ts still says what the *newer* schema was, so it
    // would be applied straight back over the top.
    if (process.argv.includes('--keep-schema')) {
      MESSAGES.SCHEMA_KEPT()
      return
    }
    await SchemaBuilder.generate(
      adapter,
      schemaPath,
      SYNC_MESSAGES,
      target.constraints,
      layout,
    )
    MESSAGES.SCHEMA_REWRITTEN({ path: schemaPath })
    MESSAGES.DONE()
  }
}

if (import.meta.main) {
  await RollbackService.run()
  process.exit(0)
}
