import type { Logger } from '@bakery-framework/core/logger'
import { Case } from '@bakery-framework/core/utils'
import type * as SyncTypes from './types'

type SyncPlan = SyncTypes.SyncPlan

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

/**
 * Shared with `sync/diff.ts`, which asks the same question about a column.
 *
 * The prompt and the bigram matcher behind it are the same for both; only the
 * wording of the question and the default threshold differ.
 */
export function findBestMatchAndPrompt(
  oldName: string,
  unmappedSet: Set<string>,
  itemType: 'table' | 'column',
  contextName: string,
  logger: Logger,
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

export function initDbTablesMap(dbConstraints: SyncTypes.DBConstraints) {
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

function tableHasTransform(tsTableObj: SyncTypes.TableConstraints): boolean {
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
  tsTableObj: SyncTypes.TableConstraints,
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

export function handleTableRenames(
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
  // Views are excluded, not merely absent. `initDbTablesMap` skips `_view`
  // entries, so a view is never in `dbTables` and would look like a table that
  // still needs creating — on every run, forever. `evaluateChanges` counts
  // `unmappedTsTables`, so a schema with a view could never report a perfectly
  // synced database. The view phase creates them; this set is about tables.
  plan.unmappedTsTables = new Set(
    Object.keys(normalizedConstraints).filter(
      camel =>
        !dbTables[camel] && !(normalizedConstraints[camel] as any)?._view,
    ),
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

export function promptAndRenameTables(
  plan: SyncPlan,
  dbTables: any,
  unmappedDbTables: Set<string>,
  logger: Logger,
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
