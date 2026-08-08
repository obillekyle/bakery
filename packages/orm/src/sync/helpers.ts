import { Case } from '@bakery/core/utils'
import { SQLAdapter } from '../adapters/base'
import type * as SyncTypes from './types'
import { resolveCurrentState } from './ledger'

export namespace SyncPlan {
  export interface TableRename {
    oldName: string
    newName: string
  }
  export interface ColumnDrop {
    table: string
    column: string
  }
  export interface ColumnAdd {
    table: string
    column: string
    def: SQLAdapter.ColumnConstraint
  }
  export interface ColumnRename {
    table: string
    oldColumn: string
    newColumn: string
  }
}

export interface SyncPlan {
  tablesToDrop: string[]
  tablesToRename: SyncPlan.TableRename[]
  columnsToDrop: SyncPlan.ColumnDrop[]
  columnsToAdd: SyncPlan.ColumnAdd[]
  columnsToRename: SyncPlan.ColumnRename[]
  tablesToRebuild: Set<string>
  /** Which source `dbConstraintsForDiff` came from, so the run can say so. */
  ledgerSource?: 'ledger' | 'introspection'
  ledgerReason?: string
  viewsToUpdate: string[]
  unmappedTsTables: Set<string>
  dbConstraintsForDiff: SyncTypes.DBConstraints
}

function getStringSimilarity(str1: string, str2: string) {
  const getBigrams = (str: string) =>
    new Set(
      Array.from({ length: str.length - 1 }, (_, i) => str.slice(i, i + 2)),
    )
  const bg1 = getBigrams(str1.toLowerCase())
  const bg2 = getBigrams(str2.toLowerCase())
  const intersection = bg1.intersection(bg2).size
  const union = bg1.union(bg2).size
  return union === 0 ? (str1 === str2 ? 1 : 0) : intersection / union
}

function findBestMatchAndPrompt(
  oldName: string,
  unmappedSet: Set<string>,
  itemType: 'table' | 'column',
  contextName: string,
  logger: any,
  threshold = 0.3,
): string | null {
  let bestAutoMatch: string | null = null
  let bestScore = 0

  for (const newCamel of unmappedSet) {
    const score = getStringSimilarity(oldName, Case.snake(newCamel))
    if (score > bestScore && score >= threshold) {
      bestScore = score
      bestAutoMatch = newCamel
    }
  }

  const unmappedArr = Array.from(unmappedSet)
  const options = [
    bestAutoMatch
      ? `Pick automatically (${Case.snake(bestAutoMatch)}: ${Math.round(bestScore * 100)}%)`
      : 'Pick automatically (none)',
    ...unmappedArr.map(t => `Use ${itemType}: ${Case.snake(t)}`),
    `Drop ${itemType}`,
  ]

  const promptMsg =
    itemType === 'table'
      ? `Unmapped database table: '${contextName}'. What should we do?`
      : `Unmapped column '${oldName}' in table '${contextName}'. What should we do?`
  const sel = logger.selectIndex(promptMsg, options)

  if (sel === 0) return bestAutoMatch
  if (sel === options.length - 1) return null
  return unmappedArr[sel - 1]
}

function initDbTablesMap(dbConstraints: SyncTypes.DBConstraints) {
  const dbTables: Record<
    string,
    { dbName: string; camelName: string; cols: Set<string> }
  > = {}
  for (const [rawTable, tableObj] of Object.entries(dbConstraints)) {
    if (tableObj._view) continue
    const camelTable = Case.camel(rawTable)
    dbTables[camelTable] = {
      dbName: Case.snake(rawTable),
      camelName: camelTable,
      cols: new Set(Object.keys(tableObj).filter(k => k !== '_view')),
    }
  }
  return dbTables
}

function tableHasTransform(tsTableObj: any): boolean {
  return (
    !!tsTableObj._transform ||
    Object.values(tsTableObj).some(
      col => col && (col as SyncTypes.ColumnConstraint)._transform,
    )
  )
}

function resolveOldTableMapping(
  plan: SyncPlan,
  dbTables: any,
  unmappedDbTables: Set<string>,
  newCamel: string,
  tsTableObj: any,
  hasTransform: boolean,
) {
  if (!tsTableObj._oldTable || !plan.unmappedTsTables.has(newCamel)) return
  const oldCamel = Case.camel(tsTableObj._oldTable)
  if (!dbTables[oldCamel]) return
  if (!hasTransform) {
    plan.tablesToRename.push({
      oldName: dbTables[oldCamel].dbName,
      newName: Case.snake(newCamel),
    })
  }
  unmappedDbTables.delete(oldCamel)
  plan.unmappedTsTables.delete(newCamel)
  dbTables[newCamel] = { ...dbTables[oldCamel], camelName: newCamel }
  delete dbTables[oldCamel]
}

function handleTableRenames(
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
  dbTables: any,
) {
  const normalizedConstraints: SyncTypes.DBConstraints = {}
  for (const [k, v] of Object.entries(constraints)) {
    normalizedConstraints[Case.camel(k)] = v
  }

  const unmappedDbTables = new Set(
    Object.keys(dbTables).filter(camel => !normalizedConstraints[camel]),
  )
  plan.unmappedTsTables = new Set(
    Object.keys(normalizedConstraints).filter(camel => !dbTables[camel]),
  )

  for (const [newRaw, tsTableObj] of Object.entries(constraints)) {
    if (!tsTableObj) continue
    const newCamel = Case.camel(newRaw)
    const hasTransform = tableHasTransform(tsTableObj)
    if (hasTransform) plan.tablesToRebuild.add(Case.snake(newCamel))
    resolveOldTableMapping(
      plan,
      dbTables,
      unmappedDbTables,
      newCamel,
      tsTableObj,
      hasTransform,
    )
  }
  return unmappedDbTables
}

function promptAndRenameTables(
  plan: SyncPlan,
  dbTables: any,
  unmappedDbTables: Set<string>,
  logger: any,
) {
  for (const oldCamel of [...unmappedDbTables]) {
    const dbName = dbTables[oldCamel]!.dbName
    const bestMatch = findBestMatchAndPrompt(
      dbName,
      plan.unmappedTsTables,
      'table',
      dbName,
      logger,
      0.5,
    )

    if (bestMatch) {
      plan.tablesToRename.push({
        oldName: dbName,
        newName: Case.snake(bestMatch),
      })
      unmappedDbTables.delete(oldCamel)
      plan.unmappedTsTables.delete(bestMatch)
      dbTables[bestMatch] = {
        ...dbTables[oldCamel]!,
        camelName: bestMatch,
      }
      delete dbTables[oldCamel]
    } else {
      plan.tablesToDrop.push(dbName)
    }
  }
}

function diffColumnMismatch(
  plan: SyncPlan,
  dbName: string,
  camelCol: string,
  tsCol: any,
  dbCol: any,
  MESSAGES: any,
) {
  const tsNullable = tsCol.primary ? false : tsCol.nullable === true
  const dbNullable = dbCol.primary ? false : dbCol.nullable === true
  const tsDefault = tsCol.default === undefined ? null : tsCol.default
  const dbDefault = dbCol.default === undefined ? null : dbCol.default
  const isTypeMatch =
    tsCol.type === dbCol.type ||
    (tsCol.type === 'boolean' && dbCol.type === 'integer')
  const norm = (v: any) =>
    v === null
      ? 'null'
      : String(v)
          .replace(/^\(+|\)+$/g, '')
          .trim()

  // Width joins the diff, so widening a Varchar migrates instead of silently
  // doing nothing. It stayed out until all three adapters could be *measured*
  // reporting it back exactly; see `SQLAdapter.sizedTextLength` for the MySQL
  // TEXT trap that made this dangerous to add blind.
  //
  // Compared only when both sides declare one. A column the schema leaves
  // unsized is not a request to shrink whatever is there — `Field.Text()`
  // against an existing VARCHAR should not rebuild the table — and a database
  // that reports no width for a sized column would otherwise rebuild forever,
  // which is the failure this guard is bought to avoid.
  const bothSized =
    typeof tsCol.length === 'number' && typeof dbCol.length === 'number'
  const lengthDiffers = bothSized && tsCol.length !== dbCol.length

  if (
    !isTypeMatch ||
    tsNullable !== dbNullable ||
    lengthDiffers ||
    norm(tsDefault) !== norm(dbDefault)
  ) {
    MESSAGES.COL_MISMATCH({ table: dbName, column: camelCol })
    MESSAGES.COL_MISMATCH_TS({
      tsType: tsCol.type,
      tsNullable: String(tsNullable),
      tsDefault: String(tsDefault),
    })
    MESSAGES.COL_MISMATCH_DB({
      dbType: dbCol.type,
      dbNullable: String(dbNullable),
      dbDefault: String(dbDefault),
    })
    plan.tablesToRebuild.add(dbName)
  }
}

function resolveColumnRenames(
  plan: SyncPlan,
  camelTable: string,
  dbName: string,
  constraints: any,
  unmappedDbCols: Set<string>,
  unmappedTsCols: Set<string>,
  existingDbCamelCols: Set<string>,
) {
  for (const newCamel of [...unmappedTsCols]) {
    const tsColObj = constraints[camelTable][newCamel]
    if (!tsColObj?._oldColumn) continue
    const oldCamel = Case.camel(tsColObj._oldColumn)
    if (!existingDbCamelCols.has(oldCamel)) continue
    plan.columnsToRename.push({
      table: dbName,
      oldColumn: Case.snake(tsColObj._oldColumn),
      newColumn: Case.snake(newCamel),
    })
    unmappedDbCols.delete(Case.snake(tsColObj._oldColumn))
    unmappedTsCols.delete(newCamel)
    if (plan.dbConstraintsForDiff[camelTable]?.[oldCamel]) {
      plan.dbConstraintsForDiff[camelTable][newCamel] =
        plan.dbConstraintsForDiff[camelTable][oldCamel]
      delete plan.dbConstraintsForDiff[camelTable][oldCamel]
    }
    existingDbCamelCols.delete(oldCamel)
    existingDbCamelCols.add(newCamel)
  }
}

function resolveUnmappedDbCols(
  plan: SyncPlan,
  camelTable: string,
  dbName: string,
  logger: any,
  unmappedDbCols: Set<string>,
  unmappedTsCols: Set<string>,
  existingDbCamelCols: Set<string>,
) {
  for (const oldDbCol of [...unmappedDbCols]) {
    const bestMatch = unmappedTsCols.size
      ? findBestMatchAndPrompt(
          oldDbCol,
          unmappedTsCols,
          'column',
          dbName,
          logger,
        )
      : null
    if (bestMatch) {
      plan.columnsToRename.push({
        table: dbName,
        oldColumn: oldDbCol,
        newColumn: Case.snake(bestMatch),
      })
      unmappedDbCols.delete(oldDbCol)
      unmappedTsCols.delete(bestMatch)
      const oldCamel = Case.camel(oldDbCol)
      if (plan.dbConstraintsForDiff[camelTable]?.[oldCamel]) {
        plan.dbConstraintsForDiff[camelTable][bestMatch] =
          plan.dbConstraintsForDiff[camelTable][oldCamel]
        delete plan.dbConstraintsForDiff[camelTable][oldCamel]
      }
      existingDbCamelCols.delete(oldCamel)
      existingDbCamelCols.add(bestMatch)
    } else {
      plan.columnsToDrop.push({ table: dbName, column: oldDbCol })
    }
  }
}

function diffTableColumns(
  plan: SyncPlan,
  camelTable: string,
  dbName: string,
  constraints: any,
  logger: any,
  MESSAGES: any,
) {
  const existingDbCamelCols = new Set(
    Object.keys(plan.dbConstraintsForDiff[camelTable] || {}).filter(
      k => k !== '_view',
    ),
  )
  const unmappedDbCols = new Set(
    [...existingDbCamelCols]
      .filter(c => !constraints[camelTable][c])
      .map(Case.snake),
  )
  const unmappedTsCols = new Set(
    Object.keys(constraints[camelTable]).filter(
      c =>
        !existingDbCamelCols.has(c) &&
        !['_view', '_oldTable', '_transform'].includes(c),
    ),
  )

  resolveColumnRenames(
    plan,
    camelTable,
    dbName,
    constraints,
    unmappedDbCols,
    unmappedTsCols,
    existingDbCamelCols,
  )
  resolveUnmappedDbCols(
    plan,
    camelTable,
    dbName,
    logger,
    unmappedDbCols,
    unmappedTsCols,
    existingDbCamelCols,
  )

  plan.columnsToAdd.push(
    ...[...unmappedTsCols].map(newCamel => ({
      table: dbName,
      column: Case.snake(newCamel),
      def: constraints[camelTable][newCamel],
    })),
  )

  for (const camelCol of existingDbCamelCols) {
    if (unmappedDbCols.has(Case.snake(camelCol))) continue
    const tsCol = constraints[camelTable][camelCol]
    const dbCol = plan.dbConstraintsForDiff[camelTable]?.[camelCol]
    if (tsCol && dbCol) {
      diffColumnMismatch(plan, dbName, camelCol, tsCol, dbCol, MESSAGES)
    }
  }
}

function diffViewStrings(
  plan: SyncPlan,
  camelTable: string,
  dbName: string,
  constraints: any,
): boolean {
  const tsViewStr = String(constraints[camelTable]._view || '')
    .replace(/\s+/g, ' ')
    .trim()
  const dbViewStr = String(plan.dbConstraintsForDiff[camelTable]?._view || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (tsViewStr || dbViewStr) {
    if (tsViewStr !== dbViewStr) plan.viewsToUpdate.push(dbName)
    if (tsViewStr && !dbViewStr) plan.tablesToDrop.push(dbName)
    return true
  }
  return false
}

function diffTableViewsAndColumns(
  plan: SyncPlan,
  dbTables: any,
  constraints: any,
  logger: any,
  MESSAGES: any,
) {
  for (const camelTable of Object.keys(dbTables)) {
    if (!constraints[camelTable]) continue
    const dbName = dbTables[camelTable]!.dbName
    if (
      plan.tablesToRebuild.has(dbName) ||
      plan.tablesToRebuild.has(Case.snake(camelTable))
    )
      continue
    if (diffViewStrings(plan, camelTable, dbName, constraints)) continue
    diffTableColumns(plan, camelTable, dbName, constraints, logger, MESSAGES)
  }
}

export async function buildSyncPlan(
  adapter: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
  logger: any,
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
  const current = await resolveCurrentState(adapter)
  plan.ledgerSource = current.source
  plan.ledgerReason = current.reason
  plan.dbConstraintsForDiff = current.constraints
  const dbTables = initDbTablesMap(plan.dbConstraintsForDiff)
  const unmappedDbTables = handleTableRenames(plan, constraints, dbTables)

  promptAndRenameTables(plan, dbTables, unmappedDbTables, logger)
  diffTableViewsAndColumns(plan, dbTables, constraints, logger, MESSAGES)

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

async function processTableRebuild(
  tx: SQLAdapter,
  table: string,
  constraints: SyncTypes.DBConstraints,
) {
  const camelTable = Case.camel(table)
  const tsTableObj = constraints[camelTable]
  const sourceDbTable = tsTableObj?._oldTable || table
  const tempName = `${table}_temp_build`

  const validCols = Object.entries(constraints[camelTable]).filter(
    ([n]) => !['_oldTable', '_transform'].includes(n),
  )
  const colDefs = validCols.map(
    ([name, cons]) => `  ${tx.quote(Case.snake(name))} ${tx.colDef(cons, Case.snake(name))}`,
  )

  await tx.createTable(tempName, colDefs)

  const currentDbCols = new Set(
    (await tx.getSchema())
      .find(t => t.name === sourceDbTable)
      ?.columns.map(c => c.name) || [],
  )
  const sharedColsList = validCols
    .map(([n]) => Case.snake(n))
    .filter(c => currentDbCols.has(c))

  const transformFn = tsTableObj?._transform
  const hasColTransforms = Object.values(constraints[camelTable]).some(
    c => (c as SyncTypes.ColumnConstraint)?._transform,
  )

  if (transformFn || hasColTransforms) {
    const oldRows = (await tx
      .query(`SELECT * FROM ${tx.quote(sourceDbTable)}`)
      .all()) as Record<string, any>[]
    const batch = oldRows.map(oldRow => {
      const keys = Object.keys(oldRow)
      const camelRow: Record<string, unknown> = {}
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i]
        camelRow[Case.camel(k)] = oldRow[k]
      }
      if (transformFn) {
        const tObj = transformFn(camelRow)! as Record<string, unknown>
        const tKeys = Object.keys(tObj)
        const result: Record<string, unknown> = {}
        for (let i = 0; i < tKeys.length; i++) {
          const k = tKeys[i]
          result[Case.snake(k)] = tObj[k]
        }
        return result
      }

      const newRecord: Record<string, any> = {}
      for (const [colName, colObj] of validCols.filter(
        ([n]) => n !== '_view',
      )) {
        const cons = colObj as SyncTypes.ColumnConstraint
        const oldColName = cons._oldColumn || colName
        const oldValue =
          camelRow[Case.camel(oldColName)] ?? camelRow[oldColName]
        newRecord[Case.snake(colName)] = cons._transform
          ? cons._transform(oldValue, camelRow)
          : (oldValue ?? cons.default ?? null)
      }
      return newRecord
    })
    if (batch.length > 0) await tx.insert(tempName, batch, false)
  } else if (sharedColsList.length > 0) {
    await tx.copyTableData(sourceDbTable, tempName, sharedColsList)
  }

  await tx.drop('TABLE', sourceDbTable)
  await tx.rename('TABLE', tempName, table)
}

function updateTableRefsAfterRename(
  plan: SyncPlan,
  oldName: string,
  newName: string,
) {
  for (const col of plan.columnsToDrop)
    if (col.table === oldName) col.table = newName
  for (const col of plan.columnsToRename)
    if (col.table === oldName) col.table = newName
  for (const col of plan.columnsToAdd)
    if (col.table === oldName) col.table = newName
}

async function dropIndexesPhase(
  tx: SQLAdapter,
  indexesToDrop: Set<string>,
  MESSAGES: any,
) {
  for (const idx of indexesToDrop) {
    MESSAGES.EXEC_DROP_INDEX({ idx })
    await tx.drop('INDEX', idx)
  }
}

async function renameTablesPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: any,
) {
  for (const { oldName, newName } of plan.tablesToRename) {
    MESSAGES.EXEC_RENAME_TABLE({ oldName, newName })
    await tx.rename('TABLE', oldName, newName)
    updateTableRefsAfterRename(plan, oldName, newName)
  }
}

async function renameColumnsPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: any,
) {
  for (const { table, oldColumn, newColumn } of plan.columnsToRename) {
    MESSAGES.EXEC_RENAME_COL({ table, oldColumn, newColumn })
    await tx.rename('COLUMN', table, oldColumn, newColumn)
  }
}

async function dropTablesPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: any,
) {
  for (const table of plan.tablesToDrop) {
    const tType = plan.dbConstraintsForDiff[Case.camel(table)]?._view
      ? 'view'
      : 'table'
    MESSAGES.EXEC_DROP_TABLE({ type: tType, table })
    await tx.drop(tType === 'view' ? 'VIEW' : 'TABLE', table)
  }
}

async function dropColumnsPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: any,
) {
  for (const { table, column } of plan.columnsToDrop) {
    MESSAGES.EXEC_DROP_COL({ table, column })
    await tx.drop('COLUMN', table, column)
  }
}

async function addColumnsPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: any,
) {
  for (const { table, column, def } of plan.columnsToAdd) {
    if (!(await tx.hasCol(table, column))) {
      MESSAGES.EXEC_ADD_COL({ table, column })
      await tx.addCol(table, column, def)
    }
  }
}

async function rebuildTablesPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
  MESSAGES: any,
) {
  for (const table of plan.tablesToRebuild) {
    MESSAGES.EXEC_REBUILD({ table })
    await processTableRebuild(tx, table, constraints)
  }
}

async function syncViewsAndTablesPhase(
  tx: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
  MESSAGES: any,
  tsFks: SyncTypes.DBForeignKeys = {},
) {
  // Parents before children: a foreign key needs the referenced table to exist,
  // and an unordered CREATE simply fails.
  for (const tableName of orderTablesByDependency(
    Object.keys(constraints),
    tsFks,
  )) {
    const cols = constraints[tableName]!
    if ((cols as SyncTypes.TableConstraints)._view) {
      MESSAGES.EXEC_SYNC_VIEW({ view: Case.snake(tableName) })
      await tx.createView(
        Case.snake(tableName),
        (cols as SyncTypes.TableConstraints)._view!,
      )
    } else {
      const colDefs = Object.entries(
        cols as Record<string, SQLAdapter.ColumnConstraint>,
      )
        .filter(([name]) => !['_oldTable', '_transform'].includes(name))
        .map(
          ([name, cons]) =>
            `  ${tx.quote(Case.snake(name))} ${tx.colDef(cons, Case.snake(name))}`,
        )
      // Inline, not a later ALTER: SQLite has no
      // `ALTER TABLE ADD FOREIGN KEY`, so this is the only spelling that works
      // on all three dialects.
      for (const fk of Object.values(tsFks)) {
        if (Case.snake(fk.table) !== Case.snake(tableName)) continue
        colDefs.push(`  ${tx.foreignKeyClause(fk)}`)
      }
      MESSAGES.EXEC_SYNC_CONS({ table: Case.snake(tableName) })
      await tx.createTable(Case.snake(tableName), colDefs, true)
    }
  }
}

async function addIndexesPhase(
  tx: SQLAdapter,
  indexesToAdd: Map<string, SyncTypes.IndexConstraint>,
  MESSAGES: any,
) {
  for (const [idxName, def] of indexesToAdd.entries()) {
    MESSAGES.EXEC_ADD_INDEX({ type: def.type, name: idxName })
    await tx.createIndex(
      idxName,
      Case.snake(def.table),
      def.cols.map(Case.snake),
      def.type === 'unique',
    )
  }
}

/**
 * Foreign keys on tables that already existed.
 *
 * Only reachable where the dialect can ALTER one in. SQLite cannot, so its
 * missing keys are handled by scheduling a table rebuild in the planner — the
 * rebuild recreates the table through `createTable`, which emits them inline.
 */
async function foreignKeysPhase(
  tx: SQLAdapter,
  fksToAdd: Map<string, SyncTypes.ForeignKeyInfo>,
  fksToDrop: Map<string, SyncTypes.ForeignKeyInfo>,
  MESSAGES: any,
) {
  if (!tx.supportsAlterForeignKey) return
  for (const fk of fksToDrop.values()) {
    MESSAGES.EXEC_DROP_FK?.({ table: fk.table, name: fk.name ?? '' })
    await tx.dropForeignKey(fk)
  }
  for (const fk of fksToAdd.values()) {
    MESSAGES.EXEC_ADD_FK?.({ table: fk.table, ref: fk.refTable })
    await tx.addForeignKey(fk)
  }
}

export async function executeSyncPlan(
  tx: SQLAdapter,
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
  indexesToDrop: Set<string>,
  indexesToAdd: Map<string, SyncTypes.IndexConstraint>,
  MESSAGES: any,
  tsFks: SyncTypes.DBForeignKeys = {},
  fksToAdd: Map<string, SyncTypes.ForeignKeyInfo> = new Map(),
  fksToDrop: Map<string, SyncTypes.ForeignKeyInfo> = new Map(),
) {
  await dropIndexesPhase(tx, indexesToDrop, MESSAGES)
  await renameTablesPhase(tx, plan, MESSAGES)
  await renameColumnsPhase(tx, plan, MESSAGES)
  await dropTablesPhase(tx, plan, MESSAGES)
  await dropColumnsPhase(tx, plan, MESSAGES)
  await addColumnsPhase(tx, plan, MESSAGES)
  await rebuildTablesPhase(tx, plan, constraints, MESSAGES)
  await syncViewsAndTablesPhase(tx, constraints, MESSAGES, tsFks)
  await addIndexesPhase(tx, indexesToAdd, MESSAGES)
  // Last, so every table a key could reference already exists.
  await foreignKeysPhase(tx, fksToAdd, fksToDrop, MESSAGES)
}


export function hasOldWrappers(constraints: SyncTypes.DBConstraints) {
  return Object.values(constraints).some(
    tObj =>
      tObj?._oldTable ||
      tObj?._transform ||
      Object.values(tObj as object).some(
        c => (c as any)?._oldColumn || (c as any)?._transform,
      ),
  )
}


/** The `foreign()` declarations, normalised into the shape the diff uses. */
export function collectForeignKeys(
  tsIndexes: SyncTypes.DBIndexes,
): SyncTypes.DBForeignKeys {
  const out: SyncTypes.DBForeignKeys = {}
  for (const [name, idx] of Object.entries(tsIndexes)) {
    if ((idx as any)?.type !== 'foreign') continue
    const fk = idx as any
    if (!fk.refTable || !fk.refCols?.length) continue
    const info: SyncTypes.ForeignKeyInfo = {
      table: fk.table,
      cols: fk.cols,
      refTable: fk.refTable,
      refCols: fk.refCols,
      name,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
    }
    out[SQLAdapter.foreignKeyId(info)] = info
  }
  return out
}

/**
 * Which foreign keys to add and which to drop.
 *
 * Keyed by the tuple, so a constraint the database named itself still matches
 * the declaration that produced it — including on SQLite, which reports no name
 * at all.
 */
export function calculateForeignKeyDiff(
  dbFks: SyncTypes.DBForeignKeys,
  tsFks: SyncTypes.DBForeignKeys,
  tablesToRebuild: Set<string>,
  /**
   * Tables that already exist, so a key on a table being *created* is left out.
   *
   * `CREATE TABLE` emits its foreign keys inline — the only spelling SQLite
   * has. Counting those as "to add" made MySQL and Postgres ALTER in a
   * constraint that already existed, and made SQLite schedule a rebuild of a
   * table that did not exist yet: a fresh `db:sync` announced
   * "Tables to rebuild: posts" against an empty database.
   *
   * Phrased as "being created" rather than "already exists" deliberately. The
   * inverse defaults to an *empty* set, which reads as "nothing exists" and so
   * suppressed every key precisely when the database was new — the case that
   * exposed this in the first place.
   */
  tablesBeingCreated: Set<string> = new Set(),
) {
  const fksToAdd = new Map<string, SyncTypes.ForeignKeyInfo>()
  const fksToDrop = new Map<string, SyncTypes.ForeignKeyInfo>()

  // `NO ACTION` on both sides of the comparison, because that is what every
  // dialect reports for a key declared without one — so an omitted action and
  // an explicit `NO ACTION` must not read as a difference.
  const act = (a?: string) => a ?? 'NO ACTION'
  const sameActions = (
    a: SyncTypes.ForeignKeyInfo,
    b: SyncTypes.ForeignKeyInfo,
  ) => act(a.onDelete) === act(b.onDelete) && act(a.onUpdate) === act(b.onUpdate)

  for (const [id, fk] of Object.entries(tsFks)) {
    // A rebuilt table is recreated from the constraints, foreign keys included,
    // so adding one separately would duplicate it.
    if (tablesToRebuild.has(Case.snake(fk.table))) continue
    if (tablesBeingCreated.has(Case.snake(fk.table))) continue

    const existing = dbFks[id]
    if (existing) {
      // Same columns, different behaviour. No dialect alters a referential
      // action in place, so the constraint is replaced — and the drop carries
      // the name the *database* gave it, which is not necessarily the one we
      // would generate for it.
      if (!sameActions(existing, fk)) {
        fksToDrop.set(id, existing)
        fksToAdd.set(id, fk)
      }
      continue
    }
    fksToAdd.set(id, fk)
  }
  for (const [id, fk] of Object.entries(dbFks)) {
    if (tsFks[id] || tablesToRebuild.has(Case.snake(fk.table))) continue
    fksToDrop.set(id, fk)
  }
  return { fksToAdd, fksToDrop }
}

/**
 * Table names ordered so a parent is always created before its children.
 *
 * Not cosmetic: a foreign key requires the referenced table to exist, so an
 * unordered CREATE fails outright — verified against Postgres, which answers
 * `relation "o_parent" does not exist`. Dropping runs in reverse for the
 * mirror-image reason.
 *
 * A cycle cannot be ordered at all. Rather than loop forever or drop tables,
 * the remainder is appended in declaration order: the foreign key that closes
 * the cycle then fails loudly at the database, which is the honest outcome —
 * breaking it needs a deferred constraint, which no dialect here spells alike.
 */
export function orderTablesByDependency(
  tables: string[],
  tsFks: SyncTypes.DBForeignKeys,
): string[] {
  const deps = new Map<string, Set<string>>()
  for (const t of tables) deps.set(Case.snake(t), new Set())
  for (const fk of Object.values(tsFks)) {
    const child = Case.snake(fk.table)
    const parent = Case.snake(fk.refTable)
    // A self-reference is satisfied by the table's own CREATE.
    if (child === parent) continue
    if (deps.has(child) && deps.has(parent)) deps.get(child)!.add(parent)
  }

  const ordered: string[] = []
  const done = new Set<string>()
  let progressed = true
  while (progressed && done.size < tables.length) {
    progressed = false
    for (const t of tables) {
      const snake = Case.snake(t)
      if (done.has(snake)) continue
      const unmet = [...(deps.get(snake) ?? [])].some(d => !done.has(d))
      if (unmet) continue
      ordered.push(t)
      done.add(snake)
      progressed = true
    }
  }
  for (const t of tables) if (!done.has(Case.snake(t))) ordered.push(t)
  return ordered
}
