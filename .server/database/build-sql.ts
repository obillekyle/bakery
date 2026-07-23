import { Case, is } from '@server/utils'
import { getActiveDb } from './connection'

function processLimitAndExists(c: any, state: any) {
  if (c._isExistsNode) {
    state.isExistsCheck = true
    state.qLimit = ' LIMIT 1'
  } else if (c._limit !== undefined) {
    if (!state.isExistsCheck) {
      state.qLimit = ` LIMIT ${c._limit}${c._offset !== undefined ? ` OFFSET ${c._offset}` : ''}`
    }
  }
}

function processSortAndFilter(c: any, state: any) {
  if (c._orderBy !== undefined && c._orderBy !== '') {
    state.qOrder = ` ORDER BY ${c._orderBy}`
  }
  if (
    c._having !== undefined &&
    Array.isArray(c._having) &&
    c._having.length > 0
  ) {
    state.qHaving = ` HAVING ${c._having.join('')}`
  }
  if (c._groupBy !== undefined && c._groupBy !== '') {
    state.qGroup = ` GROUP BY ${c._groupBy}`
  }
  if (
    c._where !== undefined &&
    Array.isArray(c._where) &&
    c._where.length > 0
  ) {
    state.qWhere = c._where.join('')
  }
}

function buildSelectColumns(
  selectMap: Record<string, any>,
  q: string,
): string[] {
  return Object.entries(selectMap).map(([alias, colObj]) => {
    const colObjRec = colObj as Record<string, any>
    const tbl = Object.keys(colObjRec)[0]!
    const col = Object.values(colObjRec)[0]
    return `${q}${Case.snake(tbl)}${q}.${q}${Case.snake(col as string)}${q} AS ${q}${alias}${q}`
  })
}

function buildSelectFunctionArg(
  funcName: string,
  alias: string,
  arg: any,
  q: string,
): string {
  if (arg === '*') return `${funcName}(*) AS ${q}${alias}${q}`
  if (is.object(arg)) {
    const argRec = arg as Record<string, any>
    const tbl = Object.keys(argRec)[0]!
    const col = Object.values(argRec)[0]
    return `${funcName}(${q}${Case.snake(tbl)}${q}.${q}${Case.snake(col as string)}${q}) AS ${q}${alias}${q}`
  }
  return `${funcName}(${q}${arg as string}${q}) AS ${q}${alias}${q}`
}

function processSelectNode(c: any, selectParts: string[], q: string) {
  const localParts: string[] = []
  if (c._selectAllAlias) {
    localParts.push(`${q}${c._selectAllAlias}${q}.*`)
  }
  if (c._select && Object.keys(c._select).length > 0) {
    localParts.push(...buildSelectColumns(c._select, q))
  }
  if (c._selectFunctions && Object.keys(c._selectFunctions).length > 0) {
    for (const [alias, funcObj] of Object.entries(c._selectFunctions)) {
      const funcObjRec = funcObj as Record<string, any>
      const funcName = Object.keys(funcObjRec)[0]
      const arg = Object.values(funcObjRec)[0]
      localParts.push(buildSelectFunctionArg(funcName as string, alias, arg, q))
    }
  }
  selectParts.unshift(...localParts)
}

function buildJoinClause(joinObj: any, q: string): string {
  const joinParts: string[] = []
  for (const [tbl, jd] of Object.entries(joinObj) as [string, any][]) {
    const onKeys = Object.keys(jd.on) as [string, string]
    if (onKeys.length >= 2) {
      joinParts.push(
        `INNER JOIN ${q}${Case.snake(tbl)}${q} AS ${q}${jd.alias}${q} ON ${q}${onKeys[0]}${q}.${q}${Case.snake(jd.on[onKeys[0]] as string)}${q} = ${q}${onKeys[1]}${q}.${q}${Case.snake(jd.on[onKeys[1]] as string)}${q}`,
      )
    }
  }
  return joinParts.length > 0 ? ` ${joinParts.join(' ')}` : ''
}

function buildWithClause(
  withObj: any,
  q: string,
): { qWith: string; cteParams: unknown[] } {
  const withParts: string[] = []
  const cteParams: unknown[] = []
  for (const [cteAlias, qb] of Object.entries(withObj) as [string, any][]) {
    const parsedCTE = buildSQL(qb as any)
    withParts.push(`${q}${cteAlias}${q} AS (${parsedCTE.sql})`)
    cteParams.push(...parsedCTE.params)
  }
  const qWith = withParts.length > 0 ? `WITH ${withParts.join(', ')} ` : ''
  return { qWith, cteParams }
}

function processTableAndJoins(c: any, state: any, q: string) {
  if (c._table !== undefined && c._table !== '') {
    state.root = c
    state.qFrom = `FROM ${q}${Case.snake(c._table)}${q}${c._alias && c._alias !== c._table ? ` AS ${q}${c._alias}${q}` : ''}`

    if (c._join && Object.keys(c._join).length > 0) {
      state.qJoin = buildJoinClause(c._join, q)
    }

    if (c._with && Object.keys(c._with).length > 0) {
      const cte = buildWithClause(c._with, q)
      state.qWith = cte.qWith
      state.cteParams.push(...cte.cteParams)
    }
  }
}

export function buildSQL(node: unknown): { sql: string; params: unknown[] } {
  const q = getActiveDb().quoteChar
  const state = {
    qLimit: '',
    qOrder: '',
    qHaving: '',
    qSelect: '*',
    qGroup: '',
    qWhere: '',
    qFrom: '',
    qJoin: '',
    qWith: '',
    root: null as any,
    cteParams: [] as unknown[],
    isExistsCheck: false,
    selectParts: [] as string[],
  }

  let curr = node
  while (curr) {
    const c = curr as any
    processLimitAndExists(c, state)
    processSortAndFilter(c, state)
    if (c._isSelectNode) {
      processSelectNode(c, state.selectParts, q)
    }
    processTableAndJoins(c, state, q)
    curr = c._previous
  }

  state.qSelect = state.isExistsCheck
    ? '1'
    : state.selectParts.length > 0
      ? state.selectParts.join(', ')
      : state.qSelect

  const sql = `${state.qWith}SELECT ${state.qSelect} ${state.qFrom}${state.qJoin}${state.qWhere}${state.qGroup}${state.qHaving}${state.qOrder}${state.qLimit}`
  return {
    sql,
    params: [
      ...state.cteParams,
      ...(state.root ? (state.root._param as unknown[]) : []),
    ],
  }
}
