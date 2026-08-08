import { Logger, messageLogger } from '@bakery/core/logger'
import type { SQLAdapter } from '../adapters/base'
import { SchemaBuilder } from './builder'
import type { SchemaLayout } from './load'
import { writeLedger } from './ledger'
import {
  buildSyncPlan,
  calculateIndexDiff,
  executeSyncPlan,
  hasOldWrappers,
  logPlannedChanges,
} from './helpers'
import type * as SyncTypes from './types'

// prettier-ignore
export const syncMsgs = {
  GEN_TYPES: 'I Generating types...',
  SYNC_SUCCESS: 'I %gschema.ts successfully synced%* to Database!',
  INVALID_SCHEMA: 'W %yschema.ts is invalid or corrupt. Treating as new.%*',
  NO_DBINFO: 'W %yDBInfo namespace not found in schema.ts!%*',
  PERFECT_SYNC: 'I %gschema.ts is perfectly synced%* with Database!',
  DB_NEWER: 'I Database is newer than TS. Generating types...',
  TS_NEWER: 'I %yschema.ts is newer! Syncing to the database...%*',
  BACKUP_CREATED: 'I Created database backup: %y{file}%*',
  SCHEMA_PRESERVED: 'I Preserved previous schema: %y{file}%*',
  NO_CONSTRAINTS:
    'E Could not find %rDBInfo.constraints%* in schema.ts to run the reverse sync!',
  COL_MISMATCH:
    "W Table '%y{table}%*' needs rebuild because of column '%y{column}%*' mismatch:",
  COL_MISMATCH_TS:
    'W   - TS: type=%c{tsType}%*, nullable=%c{tsNullable}%*, default=%c{tsDefault}%*',
  COL_MISMATCH_DB:
    'W   - DB: type=%c{dbType}%*, nullable=%c{dbNullable}%*, default=%c{dbDefault}%*',
  DANGER_ZONE: 'W %rDANGER ZONE: Destructive or major changes detected!%*',
  DROP_TABLES: 'W Tables to drop: %r{tables}%*',
  RENAME_TABLES: 'I Tables to rename: %y{tables}%*',
  DROP_COLS: 'W Columns to drop: %r{cols}%*',
  RENAME_COLS: 'I Columns to rename: %y{cols}%*',
  ADD_COLS: 'I Columns to add: %g{cols}%*',
  REBUILD_TABLES: 'W Tables to rebuild (schema modified): %r{tables}%*',
  UPDATE_VIEWS: 'I Views to update/recreate: %y{views}%*',
  DROP_INDEXES: 'I Indexes to drop: %r{indexes}%*',
  ADD_INDEXES: 'I Indexes to add: %g{indexes}%*',
  REVIEW_WARNING: 'W %yThese changes may affect data. Review carefully.%*',
  SYNC_ABORTED: 'I %ySync aborted. Your data is safe!%*',
  EXEC_RENAME_TABLE: 'I Renaming table: %y{oldName}%* -> %y{newName}%*...',
  EXEC_RENAME_COL:
    'I Renaming column: %y{table}.{oldColumn}%* -> %y{newColumn}%*...',
  EXEC_DROP_TABLE: 'I Dropping %y{type}%*: %r{table}%*...',
  EXEC_DROP_COL: 'I Dropping column: %r{table}.{column}%*...',
  EXEC_ADD_COL: 'I Adding column: %g{table}.{column}%*...',
  EXEC_DROP_INDEX: 'I Dropping index: %r{idx}%*...',
  EXEC_REBUILD:
    'I Rebuilding table to apply schema modifications: %y{table}%*...',
  EXEC_SYNC_VIEW: 'D Syncing view: %y{view}%*...',
  EXEC_SYNC_CONS: 'D Syncing constraints for: %y{table}%*...',
  EXEC_ADD_INDEX: 'I Creating %y{type}%* index: %g{name}%*...',
  CATCH_UP_SUCCESS: 'I %gDatabase successfully caught up%*!',
  PROD_FORCE_REQUIRED: 'E %rProduction requires %y--force-sync%* to proceed.%*',
  BACKUP_REQUIRED:
    'E %rAborting: this sync drops data but no backup was created. Fix the backup first.%*',
  SCHEMA_GENERATED:
    'I Database is empty. Generated %yschema.ts%* with empty boilerplate.',
  NOTHING_TO_SYNC: 'I Database and %yschema.ts%* are empty. Nothing to sync!',
  OVERRIDE_SCHEMA:
    'I %yschema.ts contains _oldTable/_transform wrappers. Overriding file to match DB.%*',
  FATAL_ERROR:
    'E %rFATAL ERROR: Sync failed! All changes have been safely rolled back. Detail: {error}%*',
} as const

const logger = new Logger('db-sync')
export const MESSAGES = messageLogger(logger, syncMsgs)

/**
 * Whether a destructive sync in this process needs an explicit `--force-sync`.
 *
 * The second half used to read `process.env.PROD === 'true'`, which could
 * never be true: `core/init.ts` installs `PROD` on `process.env` with
 * `Object.defineProperties` as a getter returning a **boolean**, so the guard
 * on the most destructive operation the framework performs rested entirely on
 * `NODE_ENV`. `import.meta.env` is the same object as `process.env` and
 * `import.meta.env.PROD` is the framework's idiom for reading these flags.
 *
 * The dead term was **deleted rather than repaired**, and that is the whole
 * decision here. `import.meta.env.PROD` means only "`--dev` is absent", and
 * `db:sync` is a separate CLI invocation that never passes `--dev` — so for
 * this caller the flag is a constant `true`, carrying no information about the
 * environment at all. Activating it would not have made the guard smarter; it
 * would have made the `isProd` branch unconditional and left `handleSafetyChecks`'s
 * interactive `Proceed with sync?` unreachable for the one workflow it exists
 * for. That is dead code traded for different dead code, plus a silent UX
 * change to the documented way of applying a schema.
 *
 * `NODE_ENV` is the only term that actually says "deployment", which is what
 * the guard is protecting against. Set it, and a destructive plan requires
 * `--force-sync`; otherwise a human at a terminal gets asked.
 *
 * Exported for the regression test: the value is process-wide ambient state,
 * and the alternative is driving `SyncEngine.run` far enough to reach a
 * `process.exit`.
 */
export function isProductionSync(): boolean {
  return process.env.NODE_ENV === 'production'
}

class SyncSession implements AsyncDisposable {
  constructor(private adapter: SQLAdapter) {}
  async [Symbol.asyncDispose]() {
    await (this.adapter as any).postSync?.(this.adapter)
  }
}

export class SyncEngine {
  protected constructor() {}

  private static async checkEmptyConstraints(
    adapter: SQLAdapter,
    constraints: SyncTypes.DBConstraints,
    genLocal: (c?: any) => Promise<void>,
    schemaPath: string,
  ): Promise<boolean> {
    const schemaExists = await Bun.file(schemaPath).exists()
    if (!schemaExists) {
      await genLocal(constraints)
      const dbConstraints = await adapter.getConstraints()
      if (Object.keys(dbConstraints).length === 0) {
        MESSAGES.SCHEMA_GENERATED()
      }
      return true
    }
    if (Object.keys(constraints).length) return false

    MESSAGES.NO_CONSTRAINTS()
    const dbConstraints = await adapter.getConstraints()

    if (Object.keys(dbConstraints).length) {
      MESSAGES.DB_NEWER()
      await genLocal(constraints)
    } else {
      MESSAGES.NOTHING_TO_SYNC()
    }

    if (process.env.DEV_WATCHER_ACTIVE && Object.keys(dbConstraints).length) {
      process.exit(42)
    }
    return true
  }

  private static evaluateChanges(
    plan: any,
    indexesToDrop: any,
    indexesToAdd: any,
  ) {
    // Index and view changes are destructive too: any index present in the DB
    // but absent from the schema is dropped, which silently removes indexes an
    // operator added by hand in production.
    const isDangerous = Boolean(
      plan.tablesToDrop.length ||
        plan.tablesToRename.length ||
        plan.columnsToDrop.length ||
        plan.columnsToRename.length ||
        plan.tablesToRebuild.size ||
        plan.viewsToUpdate.length ||
        indexesToDrop.size,
    )

    const hasChanges = Boolean(
      isDangerous ||
        plan.unmappedTsTables.size ||
        plan.columnsToAdd.length ||
        plan.viewsToUpdate.length ||
        indexesToDrop.size ||
        indexesToAdd.size,
    )

    return { isDangerous, hasChanges }
  }

  private static handleSafetyChecks(
    isDangerous: boolean,
    argv: string[],
  ): void {
    if (!isDangerous) return

    const isProd = isProductionSync()
    const force = argv.includes('--force-sync')

    if (!force)
      logger.log("I Tip: use '--choose=db', '--choose=ts', or '--dry-run'.")

    if (isProd && !force) {
      MESSAGES.PROD_FORCE_REQUIRED()
      process.exit(1)
    }

    if (!isProd && !force && !logger.confirm('Proceed with sync?')) {
      MESSAGES.SYNC_ABORTED()
      process.exit(0)
    }
  }

  private static async executeSyncPipeline(
    adapter: SQLAdapter,
    plan: any,
    constraints: SyncTypes.DBConstraints,
    indexesToDrop: any,
    indexesToAdd: any,
    genLocal: (c?: any) => Promise<void>,
    isDangerous = false,
  ): Promise<void> {
    const { backupDatabase } = await import('../backup')
    const backedUp = await backupDatabase(adapter)

    // Never run an irreversible migration without a recoverable copy.
    if (isDangerous && !backedUp) {
      MESSAGES.BACKUP_REQUIRED()
      process.exit(1)
    }

    await (adapter as any).preSync?.(adapter)

    {
      await using _session = new SyncSession(adapter)
      await adapter.transaction(tx =>
        executeSyncPlan(
          tx,
          plan,
          constraints,
          indexesToDrop,
          indexesToAdd,
          MESSAGES,
        ),
      )
    }

    // After the transaction commits, never inside it: MySQL commits DDL
    // implicitly, so there is no unit of work these two could share anyway, and
    // writing the ledger first would claim a migration that had not happened.
    // Best-effort by design — a sync that succeeded still succeeded, and a
    // missing ledger only costs the next run its fast path.
    await writeLedger(adapter, constraints)

    MESSAGES.CATCH_UP_SUCCESS()

    if (hasOldWrappers(constraints)) {
      MESSAGES.OVERRIDE_SCHEMA()
      await genLocal(constraints)
    }
  }

  static async run(
    adapter: SQLAdapter,
    constraints: SyncTypes.DBConstraints,
    tsIndexes: SyncTypes.DBIndexes,
    schemaPath: string,
    layout: SchemaLayout = 'file',
  ): Promise<void> {
    const genLocal = (c: any = {}) =>
      SchemaBuilder.generate(adapter, schemaPath, MESSAGES, c, layout)
    const isEmpty = await SyncEngine.checkEmptyConstraints(
      adapter,
      constraints,
      genLocal,
      schemaPath,
    )
    if (isEmpty) return
    // No SQLite special case here. `adjustSqlitePlan` used to rebuild every
    // renamed table and then discard `columnsToRename` wholesale whenever any
    // column rename existed, which dated from SQLite before 3.25 (2018) having
    // no ALTER TABLE … RENAME COLUMN. Bun ships 3.53. Measured against a real
    // database, the special case lost a rename in a non-renamed table silently
    // — reporting a perfect sync — and threw outright in the two cases where it
    // did fire. See sync/engine.test.ts, which pins all four.
    const plan = await buildSyncPlan(
      adapter,
      constraints,
      logger,
      MESSAGES,
    )

    const dbIndexes = await adapter.getIndexes()
    const { indexesToDrop, indexesToAdd } = calculateIndexDiff(
      dbIndexes,
      tsIndexes,
      plan.tablesToRebuild,
    )

    const { isDangerous, hasChanges } = SyncEngine.evaluateChanges(
      plan,
      indexesToDrop,
      indexesToAdd,
    )

    if (!hasChanges) {
      MESSAGES.PERFECT_SYNC()
      return
    }

    const argv = process.argv
    if (argv.find(a => a.startsWith('--choose='))?.split('=')[1] === 'db') {
      MESSAGES.GEN_TYPES()
      return await genLocal(plan.dbConstraintsForDiff)
    }
    logPlannedChanges(
      plan,
      indexesToDrop,
      indexesToAdd,
      isDangerous,
      MESSAGES,
    )
    if (argv.includes('--dry-run')) {
      logger.log(
        'D Dry-run enabled: planned changes shown above, not applying.',
      )
      return
    }

    SyncEngine.handleSafetyChecks(isDangerous, argv)
    await SyncEngine.executeSyncPipeline(
      adapter,
      plan,
      constraints,
      indexesToDrop,
      indexesToAdd,
      genLocal,
      isDangerous,
    )
  }
}
