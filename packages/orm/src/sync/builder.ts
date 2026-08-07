import { Bakery } from '@bakery/core/core/bakery'
import { isSafeIdentifier } from '../schema-util'
import type { SQLAdapter } from '../adapters/base'
import type { SchemaLayout } from './load'
import type * as SyncTypes from './types'

/**
 * Names that cannot bind a `const` in a module (modules are always strict), so
 * they cannot be used as the export name for a generated `table()`. The export
 * name is cosmetic — `InferConstraints` and `collectConstraints` both key off
 * the string passed to `table()`, not the binding — so renaming one is safe.
 */
const RESERVED_WORDS = new Set([
  'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
  'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
  'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
  'protected', 'public', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
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
        cons.nullable = existingCol ? existingCol.nullable === true : false
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

    const t = `'${cons.type}'`
    const p = cons.primary ?? false
    const a = cons.autoIncrement ?? false
    const n = p ? false : (cons.nullable ?? false)

    if (p && cons.type === 'integer' && a) {
      return `${indent}${colName}: primary(),\n`
    }

    const d = SchemaBuilder.getDefaultValue(cons, isView, adapter)

    const args = [
      t,
      d,
      n === false ? undefined : n,
      a === false ? undefined : a,
      p === false ? undefined : p,
    ]

    while (args.length > 1 && args[args.length - 1] === undefined) {
      args.pop()
    }

    const finalArgs = args.map(arg => (arg === undefined ? 'undefined' : arg))
    return `${indent}${colName}: value(${finalArgs.join(', ')}),\n`
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
        cols as Record<string, SQLAdapter.ColumnConstraint>,
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

      result += `    ${idxName}: ${idx.type}('${idx.table}', ${colsStr}),\n`
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
      let colsStr = ''
      if (cols._view) {
        colsStr += `  _view: \`${cols._view.replace(/`/g, '\\`')}\`,\n`
      }
      for (const [colName, cons] of Object.entries(
        cols as Record<string, SQLAdapter.ColumnConstraint>,
      )) {
        colsStr += SchemaBuilder.formatColumnConstraint(
          colName,
          cons,
          adapter,
          !!cols._view,
          '  ',
        )
      }
      body += `export const ${exportNameFor(tableName)} = table('${tableName}', {\n${colsStr}})\n\n`
    }

    // Imported from what was actually emitted. An import list fixed up front
    // would either miss a helper or leave an unused one in a file the app
    // typechecks.
    const helpers = ['table']
    if (/\bprimary\(/.test(body)) helpers.push('primary')
    if (/\bvalue\(/.test(body)) helpers.push('value')
    if (/\bdateNow\b/.test(body)) helpers.push('dateNow')

    return `/**
 * Generated from the database by \`db:sync\`.
 *
 * Tables only. In the orm/ folder layout \`index.ts\` owns the re-exports and
 * the schema registration and \`indexes.ts\` owns the index and unique
 * declarations, so neither is written here — but note that an index the
 * database has and \`indexes.ts\` does not declare is dropped by the next
 * TS-wins sync, which will say so before it does it.
 *
 * This file is rewritten wholesale on every regeneration; the previous copy is
 * kept under \`bakery/backups/\`.
 */
import { ${helpers.sort().join(', ')} } from '@bakery/orm'

${body}`
  }

  private static buildDbInfoBlock(
    stringifiedConstraints: string,
    stringifiedIndexes: string,
  ): string {
    return `
import {
  dateNow,
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
  index,
  old,
  primary,
  unique,
  value,
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

    const constraints = await adapter.getConstraints()

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
