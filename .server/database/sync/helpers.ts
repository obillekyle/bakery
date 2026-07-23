import { Case } from '@server/utils'
import type { SQLAdapter } from '../adapters/base'
import type * as SyncTypes from './types'

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
  for (const [camelTable, tableObj] of Object.entries(dbConstraints)) {
    if (tableObj._view) continue
    dbTables[camelTable] = {
      dbName: Case.snake(camelTable),
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
  const unmappedDbTables = new Set(
    Object.keys(dbTables).filter(camel => !constraints[camel]),
  )
  plan.unmappedTsTables = new Set(
    Object.keys(constraints).filter(camel => !dbTables[camel]),
  )

  for (const [newCamel, tsTableObj] of Object.entries(constraints)) {
    if (!tsTableObj) continue
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

  if (
    !isTypeMatch ||
    tsNullable !== dbNullable ||
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

  plan.dbConstraintsForDiff = await adapter.getConstraints()
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

  for (const [dbIdxName, dbIdx] of Object.entries(dbIndexes)) {
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
    ([name, cons]) => `  ${tx.quote(Case.snake(name))} ${tx.colDef(cons)}`,
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
) {
  for (const [tableName, cols] of Object.entries(constraints)) {
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
            `  ${tx.quote(Case.snake(name))} ${tx.colDef(cons)}`,
        )
      MESSAGES.EXEC_SYNC_CONS({ table: Case.snake(tableName) })
      await tx.createTable(tableName, colDefs, true)
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

export async function executeSyncPlan(
  tx: SQLAdapter,
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
  indexesToDrop: Set<string>,
  indexesToAdd: Map<string, SyncTypes.IndexConstraint>,
  MESSAGES: any,
) {
  await dropIndexesPhase(tx, indexesToDrop, MESSAGES)
  await renameTablesPhase(tx, plan, MESSAGES)
  await renameColumnsPhase(tx, plan, MESSAGES)
  await dropTablesPhase(tx, plan, MESSAGES)
  await dropColumnsPhase(tx, plan, MESSAGES)
  await addColumnsPhase(tx, plan, MESSAGES)
  await rebuildTablesPhase(tx, plan, constraints, MESSAGES)
  await syncViewsAndTablesPhase(tx, constraints, MESSAGES)
  await addIndexesPhase(tx, indexesToAdd, MESSAGES)
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
