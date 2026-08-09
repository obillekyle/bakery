import { Logger, messageLogger } from '@bakery/core/logger'
import { Case } from '@bakery/core/utils'
import type { SQLAdapter } from '../adapters/base'
import { SchemaBuilder } from './builder'
import {
  buildSyncPlan,
  calculateForeignKeyDiff,
  calculateIndexDiff,
  collectForeignKeys,
  executeSyncPlan,
  hasOldWrappers,
  logPlannedChanges,
} from './helpers'
import { writeLedger } from './ledger'
import type { SchemaLayout } from './load'
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
  VIEWS_SEEDED:
    'I Seeded %y{file}%* from the database. It is yours from now on — the generator will not overwrite it.',
  VIEWS_KEPT:
    'I Left %y{file}%* alone: view interfaces are hand-owned. Delete it and re-run to reseed.',
  LEDGER_DRIFT:
    'W %yDatabase has drifted from the last schema Bakery applied%*: {reason}. Diffing against live introspection instead of the ledger. Something changed this database outside Bakery — if that was not deliberate, check it before syncing.',
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
    // `viewsToUpdate` is deliberately not here, though it *is* a change below.
    //
    // Creating or recreating a view cannot lose anything: a view holds no data,
    // and `createView` drops and recreates in one step. Counting it as
    // destructive made a schema with a view demand `--force-sync` in production
    // for no reason — and it matters more now that views are diffed at all,
    // because MySQL and Postgres re-render a stored body, so a run that falls
    // back to introspection sees one as changed every time.
    //
    // Dropping a view the schema no longer declares is a different act, and it
    // lands in `tablesToDrop`, which is still dangerous.
    const isDangerous = Boolean(
      plan.tablesToDrop.length ||
        plan.tablesToRename.length ||
        plan.columnsToDrop.length ||
        plan.columnsToRename.length ||
        plan.tablesToRebuild.size ||
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
      logger.log(
        "Tip: use '--choose=db', '--choose=ts', or '--dry-run'.",
        'info',
      )

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
    tsFks: SyncTypes.DBForeignKeys = {},
    fksToAdd: Map<string, SyncTypes.ForeignKeyInfo> = new Map(),
    fksToDrop: Map<string, SyncTypes.ForeignKeyInfo> = new Map(),
    tsIndexes: SyncTypes.DBIndexes = {},
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
          tsFks,
          fksToAdd,
          fksToDrop,
        ),
      )
    }

    // After the transaction commits, never inside it: MySQL commits DDL
    // implicitly, so there is no unit of work these two could share anyway, and
    // writing the ledger first would claim a migration that had not happened.
    // Best-effort by design — a sync that succeeded still succeeded, and a
    // missing ledger only costs the next run its fast path.
    // `tsIndexes`, not `adapter.getIndexes()`: the ledger records what was
    // *applied*, and re-reading the database here would record whatever the
    // dialect reports back — the exact normalisation problem the ledger exists
    // to route around.
    await writeLedger(adapter, constraints, tsIndexes)

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
    const plan = await buildSyncPlan(adapter, constraints, logger, MESSAGES)

    // `buildSyncPlan` has always recorded which state it diffed against and
    // nothing ever read it. Falling back to introspection is *correct* — see
    // sync/ledger.ts — but doing it silently means a column somebody added by
    // hand in production looks exactly like an ordinary run. "No ledger yet" is
    // the normal state of a fresh database and is not drift.
    if (
      plan.ledgerSource === 'introspection' &&
      plan.ledgerReason &&
      plan.ledgerReason !== 'no ledger yet'
    ) {
      MESSAGES.LEDGER_DRIFT({ reason: plan.ledgerReason })
    }

    const dbIndexes = await adapter.getIndexes()
    const { indexesToDrop, indexesToAdd } = calculateIndexDiff(
      dbIndexes,
      tsIndexes,
      plan.tablesToRebuild,
    )

    const tsFks = collectForeignKeys(tsIndexes)
    const dbFks = await adapter.getForeignKeys()
    // A table being created carries its foreign keys inline from CREATE TABLE,
    // so counting them here would double up.
    const beingCreated = new Set([...plan.unmappedTsTables].map(Case.snake))
    const { fksToAdd, fksToDrop } = calculateForeignKeyDiff(
      dbFks,
      tsFks,
      plan.tablesToRebuild,
      beingCreated,
    )
    // SQLite cannot ALTER a foreign key in or out — the constraint is part of
    // the table definition — so those become table rebuilds, which recreate the
    // table with the keys inline. Decided here rather than in the adapter so
    // the printed plan states the work that will actually happen.
    if (!adapter.supportsAlterForeignKey) {
      for (const fk of [...fksToAdd.values(), ...fksToDrop.values()]) {
        plan.tablesToRebuild.add(Case.snake(fk.table))
      }
    }

    const { isDangerous, hasChanges: planChanged } = SyncEngine.evaluateChanges(
      plan,
      indexesToDrop,
      indexesToAdd,
    )
    const hasChanges = planChanged || fksToAdd.size > 0 || fksToDrop.size > 0

    if (!hasChanges) {
      MESSAGES.PERFECT_SYNC()
      return
    }

    const argv = process.argv
    if (argv.find(a => a.startsWith('--choose='))?.split('=')[1] === 'db') {
      MESSAGES.GEN_TYPES()
      return await genLocal(plan.dbConstraintsForDiff)
    }
    logPlannedChanges(plan, indexesToDrop, indexesToAdd, isDangerous, MESSAGES)
    if (argv.includes('--dry-run')) {
      // `logger.log` takes the level as its second argument. A leading 'D ' is
      // `messageLogger` table syntax, and this is not a table — so the letter
      // was printed verbatim and the level defaulted.
      //
      // `info`, not the `debug` the stray 'D' was reaching for: this line is
      // the confirmation that nothing was written. Routing it to a level that
      // is filtered by default would mean `--dry-run` could print a page of
      // destructive-looking changes and never say it did not apply them.
      logger.log(
        'Dry-run enabled: planned changes shown above, not applying.',
        'info',
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
      tsFks,
      fksToAdd,
      fksToDrop,
      tsIndexes,
    )
  }
}
