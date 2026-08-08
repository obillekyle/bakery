/**
 * Canonicalising a view's `SELECT` so the two sides of the diff can be compared.
 *
 * A view body is compared as **text** — there is no parser here, and there will
 * not be one. That works only if both sides are spelled the same way, and they
 * are not: you write
 *
 *     SELECT id, name FROM users WHERE active = 1
 *
 * and MySQL hands back
 *
 *     select `p`.`id` AS `id`,`p`.`name` AS `name` from `buzzy`.`users` `p` ...
 *
 * fully qualified, fully quoted, with every alias spelled out. Compare those
 * literally and the view is recreated on every single sync, forever — the same
 * perpetual-churn failure the column diff has hit twice.
 *
 * So everything here must hold two properties, and both are tested:
 *
 * - **Idempotent**: `f(f(x)) === f(x)`.
 * - **Convergent**: `f(what you wrote) === f(what the server returns)`.
 *
 * Which is why this only removes *noise* — quoting, schema qualification,
 * redundant aliases, whitespace. It never reorders, rewrites or reflows
 * anything semantic, because a transformation the server would not also produce
 * is one that makes the two sides differ rather than agree.
 */

/**
 * Words that must keep their quoting: unquoting one turns an identifier into
 * syntax. Deliberately small — it only has to cover words a column or table is
 * plausibly *named* after, since anything else was never quoted to begin with.
 */
const RESERVED = new Set([
  'SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL',
  'CROSS', 'ON', 'AS', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS',
  'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC', 'UNION',
  'ALL', 'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'CAST', 'BETWEEN',
  'LIKE', 'WITH', 'RECURSIVE', 'USING', 'VALUES', 'INTERVAL',
])

const PLAIN_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/

/**
 * Strip the quoting around a plain identifier, leaving anything else alone.
 *
 * Both dialect spellings, because the same schema is compared against whichever
 * server it is on: MySQL returns backticks, Postgres double quotes.
 */
function unquoteIdentifiers(sql: string): string {
  return sql.replace(/`([^`]+)`|"([^"]+)"/g, (whole, tick, dquote) => {
    const word = tick ?? dquote
    return PLAIN_IDENTIFIER.test(word) && !RESERVED.has(word.toUpperCase())
      ? word
      : whole
  })
}

/**
 * Drop `db.` from `db.table`, for the database the view lives in.
 *
 * MySQL qualifies every table in a stored view with the schema it was created
 * in, so the body carries a hard-coded database name — and the same schema
 * deployed against a differently-named database would then compare unequal and
 * be recreated forever. It is also simply wrong to write down: the view already
 * lives in that database.
 *
 * Only the view's *own* database is stripped. A genuine cross-database
 * reference keeps its qualifier, because there the name is load-bearing.
 */
function stripOwnSchema(sql: string, database?: string): string {
  if (!database) return sql
  const escaped = database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return sql.replace(new RegExp(`\\b${escaped}\\.(?=[a-zA-Z_\`"])`, 'g'), '')
}

/**
 * `x AS x` is what MySQL writes for every selected column. It says nothing, and
 * you would not have typed it.
 *
 * Matched on the *last* segment so `p.id AS id` collapses too — the qualifier
 * is part of where the value comes from, not of what the output column is
 * called.
 */
function dropRedundantAliases(sql: string): string {
  return sql.replace(
    /([a-zA-Z_][a-zA-Z0-9_]*)\s+AS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi,
    (whole, expr, alias) => (expr === alias ? expr : whole),
  )
}

/**
 * The canonical form of a view body, for comparison and for writing down.
 *
 * `database` is the schema the view belongs to; pass it and the qualifier goes.
 */
export function normalizeViewBody(sql: string, database?: string): string {
  if (!sql) return ''
  let out = String(sql).replace(/\s+/g, ' ').trim()
  out = unquoteIdentifiers(out)
  out = stripOwnSchema(out, database)
  out = dropRedundantAliases(out)
  // Qualifier removal can leave `from  products`; alias removal can leave a
  // doubled space too. Collapse once more so the result is stable under a
  // second pass — which is what makes this idempotent.
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * The same body, broken across lines for a generated file.
 *
 * Safe only because the comparison collapses whitespace before comparing: this
 * adds newlines and nothing else, so a normalised pretty body and a normalised
 * canonical one are the same string.
 */
export function formatViewBody(sql: string, database?: string): string {
  const normalized = normalizeViewBody(sql, database)
  return normalized.replace(
    /\s+(from|where|group by|order by|having|limit|left join|right join|inner join|cross join|join|union all|union)\s+/gi,
    (_m, kw) => `\n  ${String(kw).toLowerCase()} `,
  )
}
