import { Case } from '@server/utils'
import { is, throws } from '@server/utils/common'
import { getActiveDb } from './connection'
import type * as SyncTypes from './sync/types'

export type OmitNever<T> = Pick<
  T,
  { [K in keyof T]: T[K] extends never ? never : K }[keyof T]
>

export type TypeMap = {
  integer: number
  number: number
  string: string & {}
  boolean: boolean
  buffer: Buffer
}

export type DataTypes = keyof TypeMap
export type Defs<T extends keyof TypeMap> =
  | `(${string})`
  | '%dateNow%'
  | TypeMap[T]

export type TableDef<
  T extends DataTypes,
  D extends Defs<T> | null | undefined,
  N extends boolean,
  A extends boolean,
  P extends boolean,
> = OmitNever<{
  type: T
  default: D extends undefined ? never : D extends null ? never : D
  nullable: N extends true ? true : never
  autoIncrement: A extends true ? true : never
  primary: P extends true ? true : never
}>

export function value<
  T extends DataTypes,
  D extends Defs<T> | null | undefined = undefined,
  N extends boolean = false,
  A extends boolean = false,
  P extends boolean = false,
>(t: T, d?: D, n?: N, a?: A, p?: P): TableDef<T, D, N, A, P> {
  const result: Record<string, unknown> = { type: t }

  if (d !== undefined) result.default = d

  const isNullable = n !== undefined ? n : false
  if (isNullable) result.nullable = true

  const isAuto = a !== undefined ? a : false
  if (isAuto) result.autoIncrement = true

  const isPrimary = p !== undefined ? p : false
  if (isPrimary) result.primary = true

  return result as TableDef<T, D, N, A, P>
}

export function primary() {
  return value('integer', undefined, false, true, true)
}

export function unique(t: string, cols: string | string[]) {
  return {
    table: t,
    type: 'unique',
    cols: Array.isArray(cols) ? cols : [cols],
  }
}

export function index(t: string, cols: string | string[]) {
  return {
    table: t,
    type: 'index',
    cols: Array.isArray(cols) ? cols : [cols],
  }
}

export const dateNow = '%dateNow%'

export type ExtractTableTypes<C, K extends keyof C> = {
  [P in keyof C[K] as P extends '_view' ? never : P]: C[K][P] extends {
    type: infer Type
  }
    ? Type extends keyof TypeMap
      ? TypeMap[Type] | (C[K][P] extends { nullable: true } ? null : never)
      : any
    : any
}

export type ExtractOptionals<C, T extends keyof C> = {
  [K in keyof C[T]]: K extends '_view'
    ? never
    : C[T][K] extends { nullable: true }
      ? K
      : C[T][K] extends { default: string | number | boolean | null }
        ? K
        : C[T][K] extends { autoIncrement: true }
          ? K
          : never
}[keyof C[T]]

export type ExtractViews<C> = {
  [K in keyof C]: C[K] extends { _view: string } ? K : never
}[keyof C]

export function evalOperands(where: unknown, params: unknown[]): string {
  if (Array.isArray(where))
    return `(${where.map(v => evalOperands(v, params)).join(', ')})`
  if (where === null) return 'NULL'
  if (typeof where === 'object') {
    const entries = Object.entries(where)
    if (entries.length === 0) throws('Empty operands object')
    const [key, val] = entries[0]!
    const sqlFunctions = [
      'UPPER',
      'LOWER',
      'LENGTH',
      'TRIM',
      'CONCAT',
      'SUBSTR',
      'REPLACE',
    ]
    if (sqlFunctions.includes(key)) {
      const args = Array.isArray(val) ? val : [val]
      return `${key}(${args.map(arg => evalOperands(arg, params)).join(', ')})`
    }
    const q = getActiveDb().quoteChar
    return `${q}${Case.snake(key)}${q}.${q}${Case.snake(val as string)}${q}`
  }
  if (typeof where === 'boolean') return where ? 'TRUE' : 'FALSE'
  if (typeof where === 'string' && where.includes('.')) {
    const q = getActiveDb().quoteChar
    const [table, col] = where.split('.')
    return `${q}${Case.snake(table!)}${q}.${q}${Case.snake(col!)}${q}`
  }
  params.push(where)
  return '?'
}

export function old<TSchema extends SyncTypes.DBConstraints>(
  oldTableName: string,
  schema: TSchema,
  transform?: (oldRow: Record<string, unknown>) => unknown,
): TSchema

export function old<T extends SyncTypes.ColumnConstraint>(
  oldColumnName: string,
  columnDef: T,
  transform?: (oldValue: unknown, oldRow: Record<string, unknown>) => unknown,
): T

export function old(
  oldName: string,
  target: unknown,
  transform?: unknown,
): unknown {
  if (target && is.object(target) && 'type' in target) {
    return Object.assign({}, target, {
      _oldColumn: oldName,
      _transform: transform,
    })
  }

  return Object.assign({}, target, {
    _oldTable: oldName,
    _transform: transform,
  })
}
