import { Case, fs } from '@bakery/core/utils'
import { Try } from '@bakery/core/utils/common'
import { collectConstraints } from '../define'
import type * as SyncTypes from './types'

/**
 * Where a project's data model lives, and how it is read.
 *
 * Two layouts are supported. `orm/` is the newer one: tables in `schema.ts`,
 * indexes in `indexes.ts`, foreign keys in `foreign.ts`, re-exported from
 * `orm/index.ts`. A single `schema.ts` at the root still works, so nothing
 * has to move.
 *
 * The folder is not only tidier — it separates what the generator owns from
 * what a person wrote. `--choose=db` regenerates tables; with everything in
 * one file it has to rewrite indexes and foreign keys too, and anything
 * hand-authored alongside them is collateral.
 *
 * Both of those are *defaults*, probed in that order from the app's cwd. An
 * app that keeps its model somewhere else — `db/`, `src/database/`, a path
 * shared with another tool — sets `schema` in `server.config.ts` and this
 * stops guessing:
 *
 * ```ts
 * export default defineConfig({ schema: 'db/orm' })   // folder layout
 * export default defineConfig({ schema: 'db/model.ts' }) // single file
 * ```
 *
 * A configured path is resolved against the app's cwd and is **not** a hint.
 * If it does not exist the load fails (`missing`) instead of quietly falling
 * back to the defaults: a typo in that one string would otherwise leave the
 * app running against no schema at all, and `--choose=db` would then generate
 * a fresh one at the typo'd path while the real model sits untouched
 * somewhere else.
 */
/**
 * Which shape the generator must write back.
 *
 * `folder` means `table()` values in `<dir>/schema.ts`, with `<dir>/index.ts`
 * owning the re-exports and the schema registration. `file` and `none` mean the
 * single-file `DBInfo` namespace, which carries its own registration block.
 * Emitting the wrong one is not cosmetic — see `SchemaBuilder.generate`.
 */
export type SchemaLayout = 'folder' | 'file' | 'none'

export interface LoadedSchema {
  constraints: SyncTypes.DBConstraints
  indexes: SyncTypes.DBIndexes
  /**
   * `Field.Foreign()` references whose target is neither a primary key nor
   * uniquely indexed, as `child.col -> parent.col`.
   *
   * SQL forbids those. MySQL and Postgres refuse the CREATE outright; SQLite
   * accepts the DDL and then fails *every insert* with `foreign key mismatch`,
   * naming two tables and nothing else — so the caller aborts on this rather
   * than letting it surface at runtime.
   */
  unreferenceable?: string[]
  /** The file the generator should write tables back to. */
  targetPath: string
  layout: SchemaLayout
  /**
   * The path a configured `schema` pointed at that does not exist. Set only
   * for that case — never when nothing is configured, since absence is a
   * supported state for the defaults. The caller must abort rather than sync.
   */
  missing?: string
}

const CONSTRAINT_TYPES = new Set(['index', 'unique', 'foreign'])

/**
 * Foreign keys are declarable but not implemented, and the failure is nasty:
 * no adapter emits FOREIGN KEY DDL, so a declaration is created as an ordinary
 * index. The next diff then compares `foreign` in TypeScript against `index`
 * in the database, decides to drop and re-add it, and — because index drops
 * count as destructive — aborts the sync. The dev server stops starting, with
 * nothing pointing at the cause.
 *
 * Failing here converts that into one clear message. The alternative would be
 * to keep quietly creating an index, which is worse than useless: it looks
 * like referential integrity and enforces nothing.
 */
export function findUnsupportedForeignKeys(
  indexes: Record<string, unknown>,
): string[] {
  return Object.entries(indexes)
    .filter(([, entry]) => (entry as { type?: string })?.type === 'foreign')
    .map(([name]) => name)
}

/** Pull index/unique/foreign declarations out of a module's exports. */
function collectIndexes(module: Record<string, unknown>) {
  const indexes: Record<string, unknown> = {}

  for (const [name, exported] of Object.entries(module)) {
    if (!exported || typeof exported !== 'object') continue
    const entry = exported as { type?: string; table?: string }
    if (entry.type && CONSTRAINT_TYPES.has(entry.type) && entry.table) {
      indexes[name] = entry
    }
  }

  return indexes
}

/**
 * The app's configured schema location, or `undefined` for auto-detection.
 *
 * Takes the whole config object rather than the field so the one place that
 * knows the config's shape is here. `unknown` because core's `AppConfig` does
 * not declare `schema` yet — `defaultConfig` in `core/core/config.ts` is
 * annotated `Required<AppConfig>`, so declaring the field there forces a
 * default value for it, and there is no single path to give: the default is
 * the *probe*, not a location. Core spreads unknown keys from
 * `server.config.ts` through verbatim, so the option works today, and adding
 * the two lines that type it changes nothing here.
 */
export function schemaFromConfig(config: unknown): string | undefined {
  const value = (config as { schema?: unknown } | null | undefined)?.schema
  if (typeof value !== 'string') return undefined
  return value.trim() || undefined
}

async function importFresh(path: string) {
  // Cache-busted: db:sync runs repeatedly in a dev process that has already
  // imported the previous version of these modules.
  return Try.catch(import(`${path}?t=${Date.now()}`))
}

function emptyAt(targetPath: string): LoadedSchema {
  return { constraints: {}, indexes: {}, targetPath, layout: 'none' }
}

/**
 * Import `entry` and pull the schema out of it.
 *
 * `targetPath` is passed rather than derived: for the folder layout the
 * generator writes to `schema.ts` *beside* the entry, because `index.ts`
 * re-exports hand-authored `indexes.ts` / `foreign.ts` and must survive
 * `--choose=db` untouched.
 */
async function readSchema(
  entry: string,
  layout: 'folder' | 'file',
  targetPath: string,
): Promise<LoadedSchema> {
  const [error, module] = await importFresh(entry)
  if (error || !module) return emptyAt(targetPath)

  if (layout === 'folder') {
    const resolved = resolveColumnForeignKeys(
      collectConstraints(module) as SyncTypes.DBConstraints,
      collectIndexes(module) as SyncTypes.DBIndexes,
    )
    return { ...resolved, targetPath, layout: 'folder' }
  }

  // The single-file layout may declare tables either way: the original
  // `DBInfo` namespace, or `table()` values once a project starts migrating.
  const fromDbInfo = module.DBInfo?.constraints
  const constraints = fromDbInfo ?? collectConstraints(module)
  const indexes =
    module.DBInfo?.indexes ?? module.indexes ?? collectIndexes(module)

  const resolved = resolveColumnForeignKeys(
    constraints as SyncTypes.DBConstraints,
    indexes as SyncTypes.DBIndexes,
  )
  return {
    ...resolved,
    targetPath,
    layout: Object.keys(constraints).length ? 'file' : 'none',
  }
}

type Resolved =
  | { entry: string; layout: 'folder' | 'file'; targetPath: string }
  | { missing: string; targetPath: string }

/**
 * Turn a configured `schema` value into an entry file and a write target.
 *
 * Relative paths resolve against the app's cwd — the framework's own location
 * is irrelevant and, once it is an installed package, meaningless.
 *
 * A directory means the folder layout. So does a path ending in `index.ts`,
 * which is the same folder addressed by its entry file; pointing the
 * generator at that file would have it overwrite the re-exports.
 */

/**
 * Where the folder layout's table declarations live.
 *
 * `tables.ts`, beside `views.ts` and `indexes.ts` — one file per kind of
 * declaration, which is the separation the folder layout exists for. It was
 * `schema.ts`, which read oddly next to its siblings and collided with the
 * single-file layout's `schema.ts` in conversation.
 *
 * The old name is still honoured when it is the one on disk. Loading never
 * cared — that goes through `index.ts`'s re-exports, so any filename works —
 * but *generation* writes here, and writing `tables.ts` beside someone's
 * existing `schema.ts` would leave two files declaring the same tables.
 */
async function folderTarget(dir: string): Promise<string> {
  const tables = `${dir}/tables.ts`
  if (await Bun.file(tables).exists()) return tables
  const legacy = `${dir}/schema.ts`
  return (await Bun.file(legacy).exists()) ? legacy : tables
}

async function resolveConfigured(
  cwd: string,
  configured: string,
): Promise<Resolved> {
  const path = fs.resolve(cwd, configured)

  if (await fs.isDir(path)) {
    const entry = `${path}/index.ts`
    const target = await folderTarget(path)
    if (!(await Bun.file(entry).exists())) {
      return { missing: entry, targetPath: target }
    }
    return { entry, layout: 'folder', targetPath: target }
  }

  if (!(await Bun.file(path).exists()))
    return { missing: path, targetPath: path }

  if (fs.parse(path).base === 'index.ts') {
    return {
      entry: path,
      layout: 'folder',
      targetPath: await folderTarget(fs.dirname(path)),
    }
  }

  return { entry: path, layout: 'file', targetPath: path }
}

export async function loadSchema(
  cwd: string,
  configured?: string,
): Promise<LoadedSchema> {
  if (configured) {
    const resolved = await resolveConfigured(cwd, configured)
    if ('missing' in resolved) {
      return { ...emptyAt(resolved.targetPath), missing: resolved.missing }
    }
    return readSchema(resolved.entry, resolved.layout, resolved.targetPath)
  }

  const empty = emptyAt(`${cwd}/schema.ts`)

  const folderEntry = `${cwd}/orm/index.ts`
  if (await Bun.file(folderEntry).exists()) {
    const loaded = await readSchema(
      folderEntry,
      'folder',
      await folderTarget(`${cwd}/orm`),
    )
    // Unchanged from before this file learned about `config.schema`: when the
    // folder entry exists but cannot be imported, the generator stays pointed
    // at <cwd>/schema.ts. Where a *broken* module leaves the write target is a
    // separate question from where the schema is found.
    return loaded.layout === 'none' ? empty : loaded
  }

  const filePath = `${cwd}/schema.ts`
  if (!(await Bun.file(filePath).exists())) return empty

  return readSchema(filePath, 'file', filePath)
}

/**
 * Turn `Field.Foreign(users.id)` columns into real foreign key declarations.
 *
 * Runs once, where the whole schema is in scope, and does two things a column
 * cannot do on its own:
 *
 * 1. **Copies the referenced column's type onto the child.** MySQL rejects a
 *    foreign key whose types do not match exactly — an `INT` child against a
 *    `BIGINT` parent is refused — and the two declarations are usually pages
 *    apart. Copying makes the mismatch unrepresentable rather than merely
 *    unlikely. `length` comes along for a `Varchar` key, for the same reason.
 * 2. **Emits the key into the index map**, which is where `collectForeignKeys`
 *    and the diff already look. `foreign()` still exists and is unchanged; this
 *    is a second way to declare the same thing, for the single-column case.
 *
 * A reference to a table or column that does not exist is left alone rather
 * than guessed at: the column keeps its placeholder type and no key is emitted,
 * so the failure surfaces as a missing constraint rather than a silently wrong
 * one.
 */
function isUnique(
  indexes: SyncTypes.DBIndexes,
  table: string,
  column: string,
): boolean {
  return Object.values(indexes).some(
    (i: any) =>
      i?.type === 'unique' &&
      Case.snake(i.table) === Case.snake(table) &&
      i.cols?.length === 1 &&
      Case.snake(i.cols[0]) === Case.snake(column),
  )
}

export function resolveColumnForeignKeys(
  constraints: SyncTypes.DBConstraints,
  indexes: SyncTypes.DBIndexes,
): {
  constraints: SyncTypes.DBConstraints
  indexes: SyncTypes.DBIndexes
  /** References whose target is neither a primary key nor uniquely indexed. */
  unreferenceable: string[]
} {
  const out = { ...indexes } as Record<string, unknown>
  const unreferenceable: string[] = []

  for (const [tableName, cols] of Object.entries(constraints)) {
    // A view cannot carry a foreign key, and `view(name, sourceTable, body)`
    // borrows the source table's columns — `_references` included. Without this
    // the view gets a key of its own, which no dialect will create, so every
    // sync plans to add it again: an empty printed plan and a run that never
    // reports a perfectly synced database.
    if ((cols as any)?._view) continue
    for (const [colName, col] of Object.entries(cols as Record<string, any>)) {
      const ref = col?._references
      if (!ref) continue

      const target = (constraints as any)[ref.table]?.[ref.column]
      if (target) {
        col.type = target.type
        if (typeof target.length === 'number') col.length = target.length
        // Never the parent's primary/autoIncrement: the child is a plain
        // column that happens to point at one.

        // SQL requires a foreign key's target to be a primary key or carry a
        // unique index. MySQL and Postgres refuse the CREATE outright; SQLite
        // *accepts the DDL* and then fails every insert with
        // `foreign key mismatch`, naming the two tables and nothing else.
        // Saying so here, against the schema, beats debugging that at runtime.
        if (!target.primary && !isUnique(indexes, ref.table, ref.column)) {
          unreferenceable.push(
            `${tableName}.${colName} -> ${ref.table}.${ref.column}`,
          )
        }
      }

      out[`fk_${Case.snake(tableName)}_${Case.snake(colName)}`] = {
        type: 'foreign',
        table: tableName,
        cols: [colName],
        refTable: ref.table,
        refCols: [ref.column],
        onDelete: ref.onDelete,
        onUpdate: ref.onUpdate,
      }
    }
  }

  return {
    constraints,
    indexes: out as SyncTypes.DBIndexes,
    unreferenceable,
  }
}
