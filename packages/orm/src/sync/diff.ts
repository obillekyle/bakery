import type { Logger } from '@bakery-framework/core/logger'
import { Case } from '@bakery-framework/core/utils'
import { findBestMatchAndPrompt } from './rename'
import type * as SyncTypes from './types'
import { normalizeViewBody } from './view-sql'

type SyncPlan = SyncTypes.SyncPlan

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
  // Driven by the *schema* side only. When the schema declares a width, any
  // other answer from the database differs — including no width at all, which
  // is a real `TEXT` column that should become `VARCHAR(n)`. Requiring both
  // sides to be sized meant sizing an existing TEXT column silently did
  // nothing, and `db:sync` then reported a perfectly synced database whose
  // columns did not match the schema it had just read.
  //
  // Converges because all three dialects report a `VARCHAR` width back exactly
  // (measured, see `SQLAdapter.sizedTextLength`): after one rebuild the two
  // agree. A column that reports *no* width really is unsized.
  //
  // When the schema declares no width, nothing differs — `Field.Text()` against
  // an existing `VARCHAR` is not a request to shrink it.
  const lengthDiffers =
    typeof tsCol.length === 'number' && tsCol.length !== dbCol.length

  // Enum members join the diff, so changing them migrates instead of silently
  // doing nothing — but **only when the current state came from the ledger**.
  //
  // `_enum` is emitted as an inline `CHECK (col IN (...))` by all three
  // dialects, and all three *will* report that constraint back — in three
  // incompatible shapes. Measured:
  //
  //   sqlite  CHECK (status IN ('draft','live'))            in the table DDL
  //   mysql   (`status` in (_utf8mb4'draft',_utf8mb4'live'))  charset prefixes
  //   pgsql   CHECK (((status)::text = ANY ((ARRAY[...])))    re-rendered
  //
  // Postgres does not store the text it was given, it re-renders a parsed
  // expression — the same trap that turned `EXTRACT` into `date_part` and
  // rebuilt a table on every sync forever. Three parsers, each an opportunity
  // for that bug, is the wrong trade when the ledger already holds the members
  // exactly as declared.
  //
  // So under introspection this stays out of the diff. A schema-side-only
  // comparison would find `_enum` on one side and nothing on the other, differ
  // every time, and rebuild the table on every sync — which is precisely what
  // the `length` note above says it waited to rule out before shipping.
  const enumDiffers =
    plan.ledgerSource === 'ledger' &&
    !Bun.deepEquals(tsCol._enum ?? null, dbCol._enum ?? null)

  if (
    !isTypeMatch ||
    tsNullable !== dbNullable ||
    lengthDiffers ||
    enumDiffers ||
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
  logger: Logger,
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
  logger: Logger,
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
  database?: string,
): boolean {
  // Both sides through the same canonicaliser, which is the only thing that
  // makes a text comparison viable: you write `SELECT id FROM users` and MySQL
  // returns it fully qualified, fully quoted and aliased column by column.
  //
  // Symmetry is the whole requirement. Normalising the *generated file* while
  // comparing raw — or stripping the schema on one side only — recreates the
  // view on every sync, which is the same churn the column diff has hit twice.
  const tsViewStr = normalizeViewBody(
    String(constraints[camelTable]._view || ''),
    database,
  )
  const dbViewStr = normalizeViewBody(
    String(plan.dbConstraintsForDiff[camelTable]?._view || ''),
    database,
  )
  if (tsViewStr || dbViewStr) {
    if (tsViewStr !== dbViewStr) plan.viewsToUpdate.push(dbName)
    if (tsViewStr && !dbViewStr) plan.tablesToDrop.push(dbName)
    return true
  }
  return false
}

/**
 * The view lifecycle: create, recreate, drop.
 *
 * Views were invisible to the planner. `initDbTablesMap` skips `_view` entries,
 * and every existing comparison iterates that map — so a declared view never
 * reached `diffViewStrings`, and nothing about a view ever reached
 * `hasChanges`. The consequences, all three measured:
 *
 * - a **new** view was never planned,
 * - an **edited** `SELECT` was never detected, so a view could not be changed,
 * - a view the schema no longer declares was never dropped.
 *
 * They were invisible rather than broken: `syncViewsAndTablesPhase` recreates
 * every declared view whenever a sync happens to run, so a view kept up to date
 * as a side effect of unrelated work. With nothing else to do, `db:sync`
 * reported a perfectly synced database and left the view alone.
 *
 * Bodies are compared through `normalizeViewBody` on both sides. That converges
 * on SQLite, which stores the text verbatim, and via the ledger everywhere —
 * the ledger records what was *applied*, so it holds the authored SELECT.
 * Diffing against live introspection on MySQL or Postgres will still see a
 * difference, because both re-render the body (MySQL re-qualifies every column,
 * Postgres adds parentheses), and no amount of text normalisation short of a
 * parser fixes that. It costs a recreate, and a view holds no data.
 */
export function diffViews(
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
  database?: string,
) {
  const dbSide = plan.dbConstraintsForDiff
  const declared = new Set<string>()

  for (const [name, cols] of Object.entries(constraints)) {
    const body = (cols as SyncTypes.TableConstraints)?._view
    if (!body) continue
    const camel = Case.camel(name)
    declared.add(camel)

    const dbBody = (dbSide[camel] as SyncTypes.TableConstraints | undefined)
      ?._view
    const want = normalizeViewBody(String(body), database)
    const have = dbBody ? normalizeViewBody(String(dbBody), database) : null
    if (have !== want) plan.viewsToUpdate.push(Case.snake(name))
  }

  for (const [name, cols] of Object.entries(dbSide)) {
    if (!(cols as SyncTypes.TableConstraints)?._view) continue
    if (declared.has(Case.camel(name))) continue
    // Same rule tables follow: what the schema does not declare, the database
    // does not keep. Dropping is announced before it happens.
    plan.tablesToDrop.push(Case.snake(name))
  }
}

export function diffTableViewsAndColumns(
  plan: SyncPlan,
  dbTables: any,
  constraints: any,
  logger: Logger,
  MESSAGES: any,
  database?: string,
) {
  for (const camelTable of Object.keys(dbTables)) {
    if (!constraints[camelTable]) continue
    const dbName = dbTables[camelTable]!.dbName
    if (
      plan.tablesToRebuild.has(dbName) ||
      plan.tablesToRebuild.has(Case.snake(camelTable))
    )
      continue
    if (diffViewStrings(plan, camelTable, dbName, constraints, database))
      continue
    diffTableColumns(plan, camelTable, dbName, constraints, logger, MESSAGES)
  }
}
