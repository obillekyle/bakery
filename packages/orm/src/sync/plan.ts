import type { Logger } from '@bakery-framework/core/logger'
import { Case } from '@bakery-framework/core/utils'
import type { SQLAdapter } from '../adapters/base'
import { diffTableViewsAndColumns, diffViews } from './diff'
import { resolveCurrentState } from './ledger'
import {
  handleTableRenames,
  initDbTablesMap,
  promptAndRenameTables,
} from './rename'
import type * as SyncTypes from './types'

type SyncPlan = SyncTypes.SyncPlan

export async function buildSyncPlan(
  adapter: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
  logger: Logger,
  MESSAGES: any,
): Promise<SyncPlan> {
  const plan: SyncPlan = {
    tablesToDrop: [],
    tablesToRename: [],
    columnsToDrop: [],
    columnsToAdd: [],
    columnsToRename: [],
    tablesToRebuild: new Set(),
    viewsToUpdate: [],
    unmappedTsTables: new Set(),
    dbConstraintsForDiff: {},
  }

  // The one place sync decides what "currently" means. Prefers the ledger —
  // what Bakery last applied — and falls back to introspection whenever the
  // ledger no longer describes the same tables and columns. See sync/ledger.ts
  // for why that fallback is the whole safety argument.
  const current = await resolveCurrentState(adapter, {
    ignoreLedger: process.argv.includes('--no-ledger'),
  })
  plan.ledgerSource = current.source
  plan.ledgerReason = current.reason
  plan.dbConstraintsForDiff = current.constraints
  const dbTables = initDbTablesMap(plan.dbConstraintsForDiff)
  const unmappedDbTables = handleTableRenames(plan, constraints, dbTables)

  promptAndRenameTables(plan, dbTables, unmappedDbTables, logger)
  diffTableViewsAndColumns(
    plan,
    dbTables,
    constraints,
    logger,
    MESSAGES,
    adapter.databaseName,
  )
  // Separately, because every comparison above walks `dbTables`, which by
  // construction contains no views.
  diffViews(plan, constraints, adapter.databaseName)

  plan.tablesToRename = plan.tablesToRename.filter(
    t =>
      !plan.tablesToRebuild.has(t.newName) &&
      !plan.tablesToRebuild.has(t.oldName),
  )
  return plan
}

export function calculateIndexDiff(
  dbIndexes: SyncTypes.DBIndexes,
  tsIndexes: SyncTypes.DBIndexes,
  tablesToRebuild: Set<string>,
) {
  const indexesToDrop = new Set<string>()
  const indexesToAdd = new Map<string, SyncTypes.IndexConstraint>()

  // Foreign keys ride in the same declaration map as index()/unique() but are
  // a different thing: they are emitted with the table or by ALTER, never by
  // CREATE INDEX. `calculateForeignKeyDiff` owns them.
  const isFk = (i: any) => i?.type === 'foreign'

  for (const [dbIdxName, dbIdx] of Object.entries(dbIndexes)) {
    if (isFk(dbIdx)) continue
    const tsIdx = tsIndexes[dbIdxName]
    const isRebuilt = tablesToRebuild.has(Case.snake(dbIdx.table))

    if (!tsIdx) {
      indexesToDrop.add(Case.snake(dbIdxName))
    } else if (
      isRebuilt ||
      tsIdx.type !== dbIdx.type ||
      tsIdx.table !== dbIdx.table ||
      tsIdx.cols.join(',') !== dbIdx.cols.join(',')
    ) {
      if (!isRebuilt) indexesToDrop.add(Case.snake(dbIdxName))
      indexesToAdd.set(Case.snake(dbIdxName), tsIdx)
    }
  }

  for (const [tsIdxName, tsIdx] of Object.entries(tsIndexes)) {
    if (isFk(tsIdx)) continue
    if (!dbIndexes[tsIdxName]) indexesToAdd.set(Case.snake(tsIdxName), tsIdx)
  }

  return { indexesToDrop, indexesToAdd }
}

export function logPlannedChanges(
  plan: SyncPlan,
  indexesToDrop: Set<string>,
  indexesToAdd: Map<string, SyncTypes.IndexConstraint>,
  isDangerous: boolean,
  MESSAGES: any,
) {
  if (isDangerous) MESSAGES.DANGER_ZONE()
  if (plan.tablesToDrop.length)
    MESSAGES.DROP_TABLES({ tables: plan.tablesToDrop.join(', ') })
  if (plan.tablesToRename.length)
    MESSAGES.RENAME_TABLES({
      tables: plan.tablesToRename
        .map(t => `${t.oldName} -> ${t.newName}`)
        .join(', '),
    })
  if (plan.columnsToDrop.length)
    MESSAGES.DROP_COLS({
      cols: plan.columnsToDrop.map(c => `${c.table}.${c.column}`).join(', '),
    })
  if (plan.columnsToRename.length)
    MESSAGES.RENAME_COLS({
      cols: plan.columnsToRename
        .map(c => `${c.table}.${c.oldColumn} -> ${c.newColumn}`)
        .join(', '),
    })
  if (plan.columnsToAdd.length)
    MESSAGES.ADD_COLS({
      cols: plan.columnsToAdd.map(c => `${c.table}.${c.column}`).join(', '),
    })
  if (plan.tablesToRebuild.size)
    MESSAGES.REBUILD_TABLES({
      tables: Array.from(plan.tablesToRebuild).join(', '),
    })
  if (plan.viewsToUpdate.length)
    MESSAGES.UPDATE_VIEWS({ views: plan.viewsToUpdate.join(', ') })
  if (indexesToDrop.size)
    MESSAGES.DROP_INDEXES({ indexes: Array.from(indexesToDrop).join(', ') })
  if (indexesToAdd.size > 0)
    MESSAGES.ADD_INDEXES({
      indexes: Array.from(indexesToAdd.keys()).join(', '),
    })
}
