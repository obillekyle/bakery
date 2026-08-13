import { Case } from '@bakery-framework/core/utils'
import { SQLAdapter } from '../adapters/base'
import type { MESSAGES } from './engine'
import type * as SyncTypes from './types'

type SyncPlan = SyncTypes.SyncPlan

/**
 * The message table the DDL phases log through.
 *
 * Derived from the real one in `sync/engine.ts` rather than hand-written, so a
 * message that is renamed or removed there fails the build here instead of
 * printing "Error message not found" at run time. Type-only, so it adds no
 * module edge back into the engine.
 */
export type SyncMessages = typeof MESSAGES

async function processTableRebuild(
  tx: SQLAdapter,
  table: string,
  constraints: SyncTypes.DBConstraints,
  tsFks: SyncTypes.DBForeignKeys = {},
) {
  const camelTable = Case.camel(table)
  const tsTableObj = constraints[camelTable]
  const sourceDbTable = tsTableObj?._oldTable || table
  const tempName = `${table}_temp_build`

  const validCols = Object.entries(constraints[camelTable]).filter(
    ([n]) => !['_oldTable', '_transform'].includes(n),
  )
  const colDefs = validCols.map(
    ([name, cons]) =>
      `  ${tx.quote(Case.snake(name))} ${tx.colDef(cons, Case.snake(name))}`,
  )

  // Inline, or the rebuild silently drops every foreign key the table had.
  //
  // A constraint is part of the table definition, so recreating the table
  // without it removes it — and on SQLite there is no `ALTER` to put one back,
  // which is precisely why the planner turns a foreign-key change into a
  // rebuild. Without this, that plan could never *add* a key: the rebuild it
  // scheduled was the thing dropping them.
  for (const fk of Object.values(tsFks)) {
    if (Case.snake(fk.table) !== Case.snake(table)) continue
    colDefs.push(`  ${tx.foreignKeyClause(fk)}`)
  }

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
  MESSAGES: SyncMessages,
) {
  for (const idx of indexesToDrop) {
    MESSAGES.EXEC_DROP_INDEX({ idx })
    await tx.drop('INDEX', idx)
  }
}

async function renameTablesPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: SyncMessages,
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
  MESSAGES: SyncMessages,
) {
  for (const { table, oldColumn, newColumn } of plan.columnsToRename) {
    MESSAGES.EXEC_RENAME_COL({ table, oldColumn, newColumn })
    await tx.rename('COLUMN', table, oldColumn, newColumn)
  }
}

async function dropTablesPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: SyncMessages,
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
  MESSAGES: SyncMessages,
) {
  for (const { table, column } of plan.columnsToDrop) {
    MESSAGES.EXEC_DROP_COL({ table, column })
    await tx.drop('COLUMN', table, column)
  }
}

async function addColumnsPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  MESSAGES: SyncMessages,
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
  MESSAGES: SyncMessages,
  tsFks: SyncTypes.DBForeignKeys = {},
) {
  for (const table of plan.tablesToRebuild) {
    MESSAGES.EXEC_REBUILD({ table })
    await processTableRebuild(tx, table, constraints, tsFks)
  }
}

/**
 * Drop declared views before any table is rebuilt, where the dialect needs it.
 *
 * A rebuild swaps the table out and back, and two of the three dialects refuse
 * to do that while a view still names the table — SQLite at the rename, Postgres
 * at the drop. `viewsBlockTableRebuild` carries which, and why; MySQL is the one
 * that does not care and skips this entirely.
 *
 * Views hold no data and `syncViewsAndTablesPhase` recreates every declared one
 * a moment later, so dropping them first costs nothing — it is the same "drop
 * and recreate" the engine already does when a view's body changes.
 *
 * Only when something is actually being rebuilt: a sync with no rebuilds should
 * not churn views, and `CREATE VIEW` has no `IF NOT EXISTS`, so a needless drop
 * would be a needless recreate.
 */
async function dropViewsForRebuildPhase(
  tx: SQLAdapter,
  plan: SyncPlan,
  constraints: SyncTypes.DBConstraints,
) {
  if (!tx.viewsBlockTableRebuild) return
  if (!plan.tablesToRebuild.size) return
  for (const [name, cols] of Object.entries(constraints)) {
    if (!(cols as SyncTypes.TableConstraints)._view) continue
    await tx.drop('VIEW', Case.snake(name))
  }
}

async function syncViewsAndTablesPhase(
  tx: SQLAdapter,
  constraints: SyncTypes.DBConstraints,
  MESSAGES: SyncMessages,
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
        cols as Record<string, SyncTypes.ColumnConstraint>,
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
  MESSAGES: SyncMessages,
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
  MESSAGES: SyncMessages,
) {
  if (!tx.supportsAlterForeignKey) return
  for (const fk of fksToDrop.values()) {
    // Called unconditionally, like every other phase. These two were `?.` for
    // as long as `syncMsgs` did not declare them, which read as "this message
    // is optional" and was really "this message does not exist" — the optional
    // call is what let the gap survive: it type-checked, and the proxy turned
    // the miss into an error line at run time instead of a build failure.
    MESSAGES.EXEC_DROP_FK({ table: fk.table, name: fk.name ?? '' })
    await tx.dropForeignKey(fk)
  }
  for (const fk of fksToAdd.values()) {
    MESSAGES.EXEC_ADD_FK({ table: fk.table, ref: fk.refTable })
    await tx.addForeignKey(fk)
  }
}

/**
 * Everything `executeSyncPlan` needs, as one value.
 *
 * An options object rather than nine positional parameters: six of them are
 * some flavour of "a set or a map of things to change", and three carry a
 * default, so a call site that wants only the last one had to spell out the two
 * before it. The four optional members keep the defaults the positional form
 * had.
 */
export interface ExecuteSyncPlanOptions {
  /** The adapter *inside the transaction*, not the outer connection. */
  tx: SQLAdapter
  plan: SyncPlan
  constraints: SyncTypes.DBConstraints
  indexesToDrop: Set<string>
  indexesToAdd: Map<string, SyncTypes.IndexConstraint>
  MESSAGES: SyncMessages
  tsFks?: SyncTypes.DBForeignKeys
  fksToAdd?: Map<string, SyncTypes.ForeignKeyInfo>
  fksToDrop?: Map<string, SyncTypes.ForeignKeyInfo>
}

export async function executeSyncPlan({
  tx,
  plan,
  constraints,
  indexesToDrop,
  indexesToAdd,
  MESSAGES,
  tsFks = {},
  fksToAdd = new Map(),
  fksToDrop = new Map(),
}: ExecuteSyncPlanOptions) {
  await dropIndexesPhase(tx, indexesToDrop, MESSAGES)
  await renameTablesPhase(tx, plan, MESSAGES)
  await renameColumnsPhase(tx, plan, MESSAGES)
  await dropTablesPhase(tx, plan, MESSAGES)
  await dropColumnsPhase(tx, plan, MESSAGES)
  await addColumnsPhase(tx, plan, MESSAGES)
  await dropViewsForRebuildPhase(tx, plan, constraints)
  await rebuildTablesPhase(tx, plan, constraints, MESSAGES, tsFks)
  await syncViewsAndTablesPhase(tx, constraints, MESSAGES, tsFks)
  await addIndexesPhase(tx, indexesToAdd, MESSAGES)
  // Last, so every table a key could reference already exists.
  await foreignKeysPhase(tx, fksToAdd, fksToDrop, MESSAGES)
}

export function hasOldWrappers(constraints: SyncTypes.DBConstraints) {
  return Object.values(constraints).some(tObj => {
    if (tObj?._oldTable || tObj?._transform) return true
    // The two `any` casts this replaces were not simply redundant.
    // `TableConstraints` is a column map *intersected* with `_view` (a string)
    // and a table-level `_transform` (a function), so `Object.values` really
    // does yield a mixed union and `_oldColumn` really is absent from two of
    // its three members. Reading it off the string or the function gives
    // `undefined`, which is what this check wants — so the narrowing is
    // deliberate rather than a lie, and the emitted code is unchanged.
    const cols = Object.values(tObj) as (
      | SyncTypes.ColumnConstraint
      | undefined
    )[]
    return cols.some(c => c?._oldColumn || c?._transform)
  })
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
  ) =>
    act(a.onDelete) === act(b.onDelete) && act(a.onUpdate) === act(b.onUpdate)

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
