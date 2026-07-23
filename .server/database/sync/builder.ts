import type { SQLAdapter } from '../adapters/base'
import type * as SyncTypes from './types'

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
  ): string {
    if (colName === '_view') return ''

    const t = `'${cons.type}'`
    const p = cons.primary ?? false
    const a = cons.autoIncrement ?? false
    const n = p ? false : (cons.nullable ?? false)

    if (p && cons.type === 'integer' && a) {
      return `      ${colName}: primary(),\n`
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
    return `      ${colName}: value(${finalArgs.join(', ')}),\n`
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
} from '@database/schema-util';

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
`
  }

  static async generate(
    adapter: SQLAdapter,
    schemaPath: string,
    messages: any,
    existingConstraints: SyncTypes.DBConstraints = {},
  ): Promise<void> {
    messages.GEN_TYPES()

    const constraints = await adapter.getConstraints()
    const dbIndexes = await adapter.getIndexes()

    SchemaBuilder.syncNullableConstraints(constraints, existingConstraints)

    const stringifiedConstraints = SchemaBuilder.buildConstraintsString(
      constraints,
      adapter,
    )
    const stringifiedIndexes = SchemaBuilder.buildIndexesString(dbIndexes)
    const dbInfoBlock = SchemaBuilder.buildDbInfoBlock(
      stringifiedConstraints,
      stringifiedIndexes,
    )

    await Bun.write(schemaPath, dbInfoBlock)
    messages.SYNC_SUCCESS()
  }
}
