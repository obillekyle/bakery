import { Bakery } from '@bakery/core/core/bakery'
import { Case } from '@bakery/core/utils'
import type { SQLAdapter } from '../adapters/base'
import { isSafeIdentifier } from '../schema-util'
import type { SchemaLayout } from './load'
import type * as SyncTypes from './types'
import { formatViewBody } from './view-sql'

/**
 * Names that cannot bind a `const` in a module (modules are always strict), so
 * they cannot be used as the export name for a generated `table()`. The export
 * name is cosmetic — `InferConstraints` and `collectConstraints` both key off
 * the string passed to `table()`, not the binding — so renaming one is safe.
 */
const RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
])

function exportNameFor(tableName: string): string {
  const safe = tableName.replace(/[^A-Za-z0-9_]/g, '_')
  return isSafeIdentifier(safe) && !RESERVED_WORDS.has(safe)
    ? safe
    : `table_${safe}`
}

export class SchemaBuilder {
  protected constructor() {}

  private static syncNullableConstraints(
    constraints: Record<string, any>,
    existingConstraints: SyncTypes.DBConstraints,
  ): void {
    for (const [tableName, cols] of Object.entries(constraints)) {
      if (!cols._view) continue

      for (const [colName, cons] of Object.entries<any>(cols)) {
        if (colName === '_view') continue
        const existingCol = existingConstraints[tableName]?.[colName]
        // Fall back to what introspection reported, not to `false`.
        //
        // The old `: false` flattened every view column to NOT NULL whenever
        // there was no previous schema to copy from — which is exactly the
        // seeding path, the one a project with an existing database takes. On
        // a real view that made `category` and `images` non-nullable in the
        // generated interface while the database reports both nullable, so the
        // first thing the file said about the data was wrong.
        cons.nullable = existingCol
          ? existingCol.nullable === true
          : cons.nullable === true
      }
    }
  }

  private static getDefaultValue(
    cons: any,
    isView: boolean,
    adapter: SQLAdapter,
  ): string | undefined {
    if (cons.primary) return undefined
    const def = cons.default
    const nul = cons.nullable ?? false

    const hasDefault = def !== undefined && def !== null && def !== 'NULL'
    const isExplicitNull = def === null || def === 'NULL' || (!isView && nul)

    if (hasDefault) {
      const isStr = typeof def === 'string'
      const isDateNow = isStr && adapter.isDateNowDefault(def as string)

      return isStr && isDateNow
        ? 'dateNow'
        : isStr
          ? JSON.stringify(def)
          : String(def)
    }

    if (isExplicitNull) return 'null'
    return undefined
  }

  private static formatColumnConstraint(
    colName: string,
    cons: any,
    adapter: SQLAdapter,
    isView: boolean,
    indent = '      ',
  ): string {
    if (colName === '_view') return ''

    const p = cons.primary ?? false
    const a = cons.autoIncrement ?? false
    const n = p ? false : (cons.nullable ?? false)

    if (p && cons.type === 'integer' && a) {
      return `${indent}${colName}: Field.Primary(),\n`
    }

    const d = SchemaBuilder.getDefaultValue(cons, isView, adapter)
    const named = SchemaBuilder.asFieldCall(cons, d, n)
    if (named) return `${indent}${colName}: ${named},\n`

    // Nothing in the `Field` vocabulary spells this column — nullable *and*
    // defaulted to something other than null, or an explicit `primary` that is
    // not auto-increment.
    //
    // A plain object literal, not a helper call. Constraints *are* plain
    // objects, so this needs nothing imported and reads honestly as "this shape
    // has no name". It also keeps the generator total: it can always emit a
    // column, rather than dropping one it cannot spell.
    const parts = [`type: '${cons.type}'`]
    if (typeof cons.length === 'number') parts.push(`length: ${cons.length}`)
    // `d` is already source text from `getDefaultValue` — a quoted literal, a
    // bare number, `null`, or the identifier `dateNow`. The marker is spelled
    // out here instead so the emitted file needs no import for it.
    if (d !== undefined) {
      parts.push(`default: ${d === 'dateNow' ? "'%dateNow%'" : d}`)
    }
    if (n) parts.push('nullable: true')
    if (a) parts.push('autoIncrement: true')
    if (p) parts.push('primary: true')
    return `${indent}${colName}: { ${parts.join(', ')} },\n`
  }

  /**
   * The `Field` call for a column, or `null` when none fits.
   *
   * Generated schemas are the first thing most people read, and `value('string',
   * undefined, true)` teaches three positional booleans where
   * `Field.Text(true)` teaches a name. Only shapes that round-trip are emitted:
   * anything else falls through to `value()` above rather than being
   * approximated into a column that means something slightly different.
   *
   * `_enum` is deliberately absent — the members are not part of the column diff
   * and are not introspected, so the database cannot tell us an enum from a
   * `VARCHAR`, and guessing would silently invent a constraint.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: decision table: column constraints to a Field.* call
  private static asFieldCall(
    cons: any,
    def: string | undefined,
    nullable: boolean,
  ): string | null {
    if (cons.primary || cons.autoIncrement) return null
    const hasLen = typeof cons.length === 'number'
    // `undefined` from getDefaultValue means "no default", which is a different
    // column from one defaulting to null.
    const arg = def === undefined ? '' : def

    // `Field`'s one convention is that a **null default means nullable**, which
    // makes "nullable *and* defaulted to something else" unspellable: emitting
    // `Field.Int(0)` for `value('integer', 0, true)` would quietly turn a
    // nullable column into NOT NULL. That shape falls through to `value()`,
    // which has a separate argument for it.
    if (nullable && def !== undefined && def !== 'null') return null

    // Markers are matched on the *raw* default, not on `def`, which is already
    // source text: `getDefaultValue` turns `%dateNow%` into the identifier
    // `dateNow` and `%uuid%` into a quoted literal, so comparing against either
    // spelling is a guess about formatting rather than about the column.
    //
    // Emitting `Field.Uuid()` / `Field.Date.now()` also removes the need for the
    // `dateNow` import, which is added only when the body still mentions it.
    if (cons.type === 'string' && cons.default === '%uuid%')
      return 'Field.Uuid()'
    switch (cons.type) {
      case 'integer':
        if (cons.default === '%dateNow%') return 'Field.Date.now()'
        return nullable && def === undefined ? null : `Field.Int(${arg})`
      case 'number':
        return nullable && def === undefined ? null : `Field.Float(${arg})`
      case 'boolean':
        return nullable && def === undefined ? null : `Field.Bool(${arg})`
      case 'bigint':
        return nullable && def === undefined ? null : `Field.BigInt(${arg})`
      case 'buffer':
        // `Field.Blob()` is always nullable, so it can only stand in for one.
        return nullable && def === 'null' ? 'Field.Blob()' : null
      case 'json':
        if (def === undefined) return 'Field.Json()'
        return nullable && def === 'null' ? 'Field.Json(true)' : null
      case 'string':
        if (hasLen)
          return `Field.Varchar(${cons.length}${arg ? `, ${arg}` : ''})`
        if (def === undefined)
          return nullable ? 'Field.Text(true)' : 'Field.Text()'
        return `Field.String(${arg})`
      default:
        return null
    }
  }

  /**
   * The TypeScript type of a column, for a generated view interface.
   *
   * A view has no column DDL, so this is the only place its columns appear.
   * Straight through `TypeMap`'s mapping, with `| null` for a nullable column —
   * introspection reports that faithfully for a view's projected columns.
   */
  private static tsTypeFor(cons: any): string {
    const base =
      {
        integer: 'number',
        number: 'number',
        bigint: 'number',
        string: 'string',
        boolean: 'boolean',
        buffer: 'Buffer',
        json: 'unknown',
      }[cons.type as string] || 'unknown'
    return cons.nullable ? `${base} | null` : base
  }

  /**
   * `orm/views.ts`: one interface plus one `view()` per view in the database.
   *
   *     export interface ActiveUsersView {
   *       id: number
   *       name: string
   *     }
   *
   *     export const activeUsers = view<'active_users', ActiveUsersView>(
   *       'active_users',
   *       `SELECT ...`,
   *     )
   *
   * The interface is what a view *is* — `CREATE VIEW` declares no column types,
   * so emitting `Field.Varchar(64)` here would state a width the database
   * neither stores nor enforces. It is also the thing worth exporting: the row
   * type gets a name you can use in a signature.
   *
   * Both type arguments are written out because TypeScript stops inferring the
   * rest once one is supplied, and the *name* has to stay a literal — it is
   * what the schema map is keyed on. Generated code, so the repetition is free.
   */
  private static buildViewModule(
    constraints: Record<string, any>,
    database?: string,
  ): string | null {
    const views = Object.entries(constraints).filter(([, c]) => c?._view)
    if (!views.length) return null

    let body = ''
    for (const [name, cols] of views) {
      // `productView` would otherwise become `ProductViewView`. Naming a view
      // `*_view` is common enough that the stutter is the normal case, not the
      // edge one.
      const pascal = Case.pascal(name)
      const iface = /view$/i.test(pascal) ? pascal : `${pascal}View`
      let fields = ''
      for (const [colName, cons] of Object.entries<any>(cols)) {
        if (colName === '_view') continue
        fields += `  ${colName}: ${SchemaBuilder.tsTypeFor(cons)}\n`
      }
      body +=
        `export interface ${iface} {\n${fields}}\n\n` +
        `export const ${exportNameFor(name)} = view<'${name}', ${iface}>(\n` +
        `  '${name}',\n` +
        `  \`${formatViewBody(String(cols._view), database).replace(/`/g, '\\`')}\`,\n` +
        `)\n\n`
    }

    return `/**
 * Views, seeded from the database by \`db:sync --choose=db\`.
 *
 * A view is a stored SELECT; it has no column DDL, so each one is described by
 * an interface rather than by column builders. Edit the SELECT here and the
 * next sync recreates the view — views hold no data, so there is nothing to
 * migrate.
 *
 * **This file is yours from now on. The generator writes it once and never
 * overwrites it**, because the interfaces are the part worth editing by hand:
 * introspection can only report a JSON column as \`unknown\`, and the shape it
 * actually holds — \`{ id: number; name: string }[]\` for a
 * \`json_arrayagg(json_object(...))\` — is knowledge only you have. Regenerating
 * over that would throw away the reason for writing it down.
 *
 * A view added to the database later will not appear here on its own; add it,
 * or delete this file and re-run to reseed the lot.
 */
import { view } from '@bakery/orm'

${body}`
  }

  private static buildConstraintsString(
    constraints: Record<string, any>,
    adapter: SQLAdapter,
  ): string {
    let result = '{\n'
    for (const [tableName, cols] of Object.entries(constraints)) {
      result += `    ${tableName}: {\n`

      if (cols._view) {
        result += `      _view: \`${cols._view.replace(/`/g, '\\`')}\`,\n`
      }

      for (const [colName, cons] of Object.entries(
        cols as Record<string, SyncTypes.ColumnConstraint>,
      )) {
        result += SchemaBuilder.formatColumnConstraint(
          colName,
          cons,
          adapter,
          !!cols._view,
        )
      }
      result += `    },\n`
    }
    return `${result}  } as const;\n`
  }

  private static buildIndexesString(dbIndexes: Record<string, any>): string {
    let result = '{\n'
    for (const [idxName, idx] of Object.entries(dbIndexes)) {
      const colsStr =
        idx.cols.length === 1
          ? `'${idx.cols[0]}'`
          : `[${idx.cols.map((c: string) => `'${c}'`).join(', ')}]`

      // `Field.Index` / `Field.Unique`, capitalised from the stored `index` /
      // `unique` type. This emitted the bare `index(…)` / `unique(…)` names
      // until they were removed, at which point the generated file referenced
      // two identifiers it did not import — invisible here because the *tables*
      // are what the round-trip test imports, not the index block.
      const fn = idx.type === 'unique' ? 'Field.Unique' : 'Field.Index'
      result += `    ${idxName}: ${fn}('${idx.table}', ${colsStr}),\n`
    }
    return `${result}  } as const;\n`
  }

  /**
   * The `orm/` folder layout's `schema.ts`: `table()` values and nothing else.
   *
   * The generator only ever emitted the `DBInfo` namespace, and for a folder
   * project the write target is `orm/schema.ts` — which `orm/index.ts`
   * re-exports. So a regeneration replaced every `table()` with a namespace
   * *and* added a second `declare module '@bakery/orm/schema-registry'` block
   * colliding with the one in `index.ts`. It fired on `--choose=db` and, less
   * visibly, after any sync involving `old()` wrappers.
   *
   * Tables only, deliberately: `index.ts` owns the re-exports and the schema
   * registration, `indexes.ts` owns the index and unique declarations, and
   * neither is the generator's to rewrite. That separation is the reason the
   * folder layout exists (see `load.ts`).
   */
  private static buildTableModule(
    constraints: Record<string, any>,
    adapter: SQLAdapter,
  ): string {
    let body = ''
    for (const [tableName, cols] of Object.entries(constraints)) {
      // Views are left to `views.ts`, exactly as indexes are left to
      // `indexes.ts`. This file is the only one the generator owns; emitting a
      // view here as well would leave the same declaration in two files after
      // a single `--choose=db`, and `collectConstraints` would silently keep
      // whichever was exported last.
      if (cols._view) continue
      let colsStr = ''
      for (const [colName, cons] of Object.entries(
        cols as Record<string, SyncTypes.ColumnConstraint>,
      )) {
        colsStr += SchemaBuilder.formatColumnConstraint(
          colName,
          cons,
          adapter,
          // Never a view here — those were skipped above.
          false,
          '  ',
        )
      }
      body += `export const ${exportNameFor(tableName)} = table('${tableName}', {\n${colsStr}})\n\n`
    }

    // Imported from what was actually emitted. An import list fixed up front
    // would either miss a helper or leave an unused one in a file the app
    // typechecks.
    // `table`, plus `Field` when the body uses one. Nothing else: a column
    // `Field` cannot spell is emitted as a plain object literal, which imports
    // nothing at all.
    const helpers = ['table']
    if (/\bField\./.test(body)) helpers.push('Field')

    return `/**
 * Generated from the database by \`db:sync\`.
 *
 * Tables only. In the orm/ folder layout \`index.ts\` owns the re-exports and
 * the schema registration, \`indexes.ts\` owns the index and unique
 * declarations, and \`views.ts\` owns the views — none of which is written here.
 *
 * The cost of that separation, worth knowing: an index or a view the database
 * has and its file does not declare is dropped by the next TS-wins sync. It
 * says so before it does it.
 *
 * This file is rewritten wholesale on every regeneration; the previous copy is
 * kept under \`bakery/backups/\`.
 */
import { ${helpers.sort().join(', ')} } from '@bakery/orm'

${body}`
  }

  /**
   * The standalone `schema.ts`: constraints, indexes and the registration block.
   *
   * `Field` is imported from the package root and the types from
   * `schema-util`, in two statements rather than one, because `schema-util`
   * cannot re-export `Field` without closing a cycle — `field.ts` calls
   * `value`/`primary`/`index`/`unique`, and this repo has already paid once for
   * a cycle that typechecked and then failed at runtime.
   */
  private static buildDbInfoBlock(
    stringifiedConstraints: string,
    stringifiedIndexes: string,
  ): string {
    return `
import { Field } from '@bakery/orm';
import {
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
  old,
} from '@bakery/orm/schema-util';

export namespace DBInfo {
  export const constraints = ${stringifiedConstraints}
  export const indexes = ${stringifiedIndexes}
  type C = typeof constraints;
  export type Table<T extends keyof C> = ExtractTableTypes<C, T>;
  export type Optionals<T extends keyof C> = ExtractOptionals<C, T>;
  export type Views = ExtractViews<C>;
}

export type DBSchema = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Table<T>;
};

export type DBOptionals = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Optionals<T>;
};

/**
 * Registers this schema with the framework's type system. Generated
 * deliberately: the framework never imports schema.ts, so without this block
 * the ORM still runs but every table and column is \`any\`.
 */
declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: DBSchema;
      DBOptionals: DBOptionals;
      Views: DBInfo.Views;
    };
  }
}
`
  }

  static async generate(
    adapter: SQLAdapter,
    schemaPath: string,
    messages: any,
    existingConstraints: SyncTypes.DBConstraints = {},
    layout: SchemaLayout = 'file',
  ): Promise<void> {
    messages.GEN_TYPES()

    // Stripped, or `--choose=db` writes `__bakery_schema` into the app's own
    // schema as an ordinary table — after which sync manages the ledger, the
    // ledger records itself, and the shape check never matches again. The diff
    // path strips it in `resolveCurrentState`; this path reads the adapter
    // directly and was missing it.
    const { stripLedger } = await import('./ledger')
    const constraints = stripLedger(await adapter.getConstraints())

    SchemaBuilder.syncNullableConstraints(constraints, existingConstraints)

    // The write target and the shape written have to agree. `folder` means
    // `orm/schema.ts` beside an `index.ts` that already registers the schema;
    // `file`/`none` mean a standalone schema.ts that has to register itself.
    const source =
      layout === 'folder'
        ? SchemaBuilder.buildTableModule(constraints, adapter)
        : SchemaBuilder.buildDbInfoBlock(
            SchemaBuilder.buildConstraintsString(constraints, adapter),
            SchemaBuilder.buildIndexesString(await adapter.getIndexes()),
          )

    const preserved = await SchemaBuilder.preserveExisting(schemaPath)
    if (preserved) messages.SCHEMA_PRESERVED({ file: preserved })

    await Bun.write(schemaPath, source)

    // `views.ts` beside `tables.ts`, and only in the folder layout — the
    // single-file layout already carries views inside its `DBInfo` namespace.
    //
    // Written only when the database *has* views: creating an empty file, and
    // then an `export * from './views'` that resolves to nothing, would be
    // noise in every project that has none.
    if (layout === 'folder') {
      const viewsSource = SchemaBuilder.buildViewModule(
        constraints,
        adapter.databaseName,
      )
      if (viewsSource) {
        const viewsPath = `${schemaPath.replace(/[^/\\]+$/, '')}views.ts`
        // Seeded once, then never overwritten — unlike `tables.ts`, which the
        // generator owns outright.
        //
        // The interfaces are the part worth editing by hand. Introspection can
        // only ever report a JSON column as `unknown`; that a
        // `json_arrayagg(json_object(...))` column holds
        // `{ id: number; name: string }[]` is knowledge the schema does not
        // carry and the database cannot state. Overwriting would delete exactly
        // the work the interface form exists to make possible.
        if (await Bun.file(viewsPath).exists()) {
          messages.VIEWS_KEPT?.({ file: viewsPath })
        } else {
          await Bun.write(viewsPath, viewsSource)
          messages.VIEWS_SEEDED?.({ file: viewsPath })
        }
      }
    }

    messages.SYNC_SUCCESS()
  }

  /** Keep this many previous schemas; the rest are pruned oldest-first. */
  private static readonly SCHEMA_BACKUPS = 10

  /**
   * Copy the current schema aside before it is overwritten.
   *
   * `--choose=db` regenerates the schema wholesale, and anything hand-written
   * in it — a comment, a `_view`, an `old()` rename wrapper — is gone. The
   * database is backed up before a destructive sync; the schema, which is
   * source, was not. It is also gitignored, so `git checkout` cannot recover
   * it either: this is the one file with no other safety net.
   *
   * Stored under `bakery/backups` (`Bakery.dataDir`) rather than the cache,
   * because a cache is defined as safe to delete and this is not — the
   * framework itself deletes the cache directory on every version bump.
   */
  private static async preserveExisting(
    schemaPath: string,
  ): Promise<string | null> {
    const current = Bun.file(schemaPath)
    if (!(await current.exists())) return null

    const contents = await current.text()
    if (!contents.trim()) return null

    const dir = `${Bakery.dataDir}/backups`
    const name = `schema.${Date.now()}.ts`
    await Bun.write(`${dir}/${name}`, contents)

    await SchemaBuilder.pruneSchemaBackups(dir)
    return name
  }

  private static async pruneSchemaBackups(dir: string) {
    const { readdir, unlink } = await import('node:fs/promises')
    const entries = await readdir(dir).catch(() => [] as string[])

    const backups = entries
      .filter(name => /^schema\.\d+\.ts$/.test(name))
      .sort()
      .reverse()

    for (const stale of backups.slice(SchemaBuilder.SCHEMA_BACKUPS)) {
      await unlink(`${dir}/${stale}`).catch(() => {})
    }
  }
}
