/**
 * How a row is named.
 *
 * Every write endpoint addresses rows through this module and nothing else,
 * because the three obvious alternatives are all broken and the explorer
 * inherited none of them:
 *
 *   - **`rowid`** (SQLite) is absent from a `WITHOUT ROWID` table and is not
 *     stable across a `VACUUM`.
 *   - **`ctid`** (Postgres) is the *physical* location of a tuple and moves on
 *     every UPDATE. Reading a page, editing two rows and writing the second by
 *     the ctid the read returned edits whatever now sits in that slot.
 *   - **`getSchema()`'s first `pk` column**, which the dashboard uses on MySQL.
 *     On a composite key that predicate matches every row sharing the first
 *     column, so one edit rewrites all of them. Silently.
 *
 * What replaces them is a declared key: a primary key, or failing that a unique
 * index over columns that cannot be null. A table with neither cannot have one
 * of its rows named at all, so it is read-only for everybody — a 409, not a
 * best guess.
 *
 * ## The two traps this module exists to absorb
 *
 * `getConstraints()` camel-cases **both** the table key and every column key
 * (`Case.camel`), while `getSchema()` and `getData()` speak raw database names.
 * The bridge between them is here and only here; `Case.snake` is not the
 * inverse of `Case.camel` (`SKU_code` → `sKUCode` → `s_k_u_code`), so raw names
 * are carried through from `getSchema()` rather than reconstructed.
 *
 * And `getConstraints()` includes **views**, which carry a `_view` key. A view
 * has no rows of its own to address, so it is always `none`.
 */

import { Case } from '@bakery-framework/core/utils'
import type { SQLAdapter } from '@bakery-framework/orm/adapters'
import { connection } from '@bakery-framework/orm/connection'
import type { ColumnKind, ColumnMeta } from './shared/coerce'

/**
 * The shapes the adapter reports, derived from its own signatures rather than
 * imported: `@bakery-framework/orm` does not export `sync/types`, and adding a
 * subpath to another package's export map to read three optional fields is a
 * public-API decision this plugin does not get to make on its own.
 */
export type TableConstraints = Awaited<
  ReturnType<SQLAdapter['getConstraints']>
>[string]
export type TableDetails = Awaited<ReturnType<SQLAdapter['getSchema']>>[number]
export type IndexEntry = Awaited<ReturnType<SQLAdapter['getIndexes']>>[string]

/**
 * One column of `TableConstraints`, structurally.
 *
 * Spelled out because `TableConstraints` is an intersection of an index
 * signature with `_view`/`_oldTable`/`_transform`, so indexing it does not
 * narrow to the column type on its own.
 */
export interface ColumnConstraint {
  type?: string
  length?: number
  _enum?: readonly string[]
  primary?: boolean
  autoIncrement?: boolean
  nullable?: boolean
  default?: unknown
}

export type IdentityMode = 'pk' | 'unique' | 'none'

export interface Identity {
  mode: IdentityMode
  /** Raw database column names, in a stable order. Empty when `mode` is `none`. */
  cols: string[]
  /** Why there is no identity. Present only when `mode` is `none`. */
  reason?: string
}

export interface TableIntrospection {
  /** The raw database table name. */
  name: string
  /** `getConstraints()[Case.camel(name)]`, camel-keyed, possibly `_view`. */
  constraints: TableConstraints
  /** This table's `getIndexes()` entries, with camel-cased column names. */
  indexes: { name: string; type: string; cols: string[] }[]
  /** Raw database column names, in `getSchema()` order. */
  columns: string[]
}

/**
 * Can this identifier survive being written into a statement?
 *
 * `qId` — the single SQL identifier writer (convention 8) — snake-cases before
 * quoting, so `qId('Orders')` emits `"orders"`. For every name the ORM created
 * that is a no-op, because it snake-cases on the way in too. For a table some
 * other tool created with a capital in it, it is a statement against a
 * different object, and on a case-sensitive MySQL install that object may not
 * exist or may be a different table entirely.
 *
 * So a name that does not round-trip is refused rather than quietly rewritten.
 * The cost is that such a table is read-only in the explorer; the alternative
 * is writing to a table the user did not name.
 */
export function isAddressable(name: string): boolean {
  return Case.snake(name) === name
}

/** Build the camel-key → raw-name map `getConstraints()` needs to be read through. */
function rawByCamel(columns: readonly string[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of columns) {
    const camel = Case.camel(raw)
    // First wins: two raw columns can camel-case alike (`user_id` and `userId`
    // in the same table), and a later one must not silently take over the
    // earlier one's constraints.
    if (!map.has(camel)) map.set(camel, raw)
  }
  return map
}

/**
 * A column key of `TableConstraints` that is really a column.
 *
 * `_view`, `_oldTable` and `_transform` share the same object. No real column
 * can collide with them: `Case.camel` strips a leading underscore, so a column
 * genuinely named `_view` is filed under `view`.
 */
function isColumnKey(key: string): boolean {
  return !key.startsWith('_')
}

const none = (reason: string): Identity => ({ mode: 'none', cols: [], reason })

/**
 * The identity of one table, in the order the brief fixes: declared primary
 * key, else the narrowest all-NOT-NULL unique index, else nothing.
 */
export function describeIdentity(table: TableIntrospection): Identity {
  if (!isAddressable(table.name)) {
    return none(
      `the table name ${table.name} is not addressable — ` +
        'identifiers are snake-cased before they are quoted',
    )
  }

  const constraints = table.constraints as Record<string, unknown>
  if (typeof constraints._view === 'string') {
    return none('a view has no rows of its own to address')
  }

  const raw = rawByCamel(table.columns)
  const column = (camel: string): ColumnConstraint | undefined =>
    isColumnKey(camel) ? (constraints[camel] as ColumnConstraint) : undefined

  // 1. Primary key. Composite is the normal case, not an exception — walked in
  //    `getSchema()` column order so a composite key has a stable spelling
  //    rather than whatever order the introspection query returned.
  const primary = table.columns.filter(
    name => column(Case.camel(name))?.primary === true,
  )
  if (primary.length) {
    const unaddressable = primary.filter(c => !isAddressable(c))
    if (unaddressable.length) {
      return none(
        `primary key columns are not addressable: ${unaddressable.join(', ')}`,
      )
    }
    return { mode: 'pk', cols: primary }
  }

  // 2. The narrowest unique index whose every column is declared NOT NULL.
  //    NULL is the whole reason for that condition: `NULL = NULL` is unknown,
  //    so a predicate over a nullable unique column matches no row, and an
  //    UPDATE that reports zero changes is indistinguishable from a conflict.
  const candidates = table.indexes
    .filter(index => index.type === 'unique')
    .map(index => ({
      name: index.name,
      cols: index.cols.map(camel => raw.get(camel)),
    }))
    .filter(
      (index): index is { name: string; cols: string[] } =>
        index.cols.length > 0 &&
        index.cols.every(
          col =>
            typeof col === 'string' &&
            isAddressable(col) &&
            // `nullable === false` explicitly, never `!nullable`. An adapter
            // that reported nothing for a column would otherwise read as NOT
            // NULL, which is the fail-open direction (convention 2).
            column(Case.camel(col))?.nullable === false,
        ),
    )
    // Narrowest first; ties broken by index name so two equally narrow keys
    // do not depend on introspection order.
    .sort(
      (a, b) => a.cols.length - b.cols.length || a.name.localeCompare(b.name),
    )

  const chosen = candidates[0]
  if (chosen) return { mode: 'unique', cols: chosen.cols }

  return none(
    'no primary key and no unique index over NOT NULL columns — ' +
      'there is no way to name one row of this table',
  )
}

export interface ColumnFacts {
  /** The raw database column name — what goes into a statement. */
  name: string
  /** The key `getConstraints()` filed it under. */
  camel: string
  /** The database's own type string, from `getSchema()`. */
  sqlType: string
  meta: ColumnMeta
}

export interface TableFacts {
  name: string
  camel: string
  isView: boolean
  rowCount: number
  columns: ColumnFacts[]
  /** By raw column name. */
  byName: Map<string, ColumnFacts>
  identity: Identity
  /**
   * The first text column that is not part of the identity — what a foreign-key
   * reference shows instead of a bare id. `null` when the table has none.
   */
  label: string | null
}

/** Genuine date/time column types, as the three dialects spell them. */
const RX_DATE_TYPE = /^(date|datetime|timestamp)/i

/**
 * What kind of value a column holds.
 *
 * `getConstraints()` is the authority, with one exception it cannot express:
 * `ColumnType` has no date member, so every adapter maps a real `DATE` or
 * `TIMESTAMP` to `string` (MySQL explicitly, Postgres by falling through). The
 * raw SQL type is the only place that distinction survives, and it matters —
 * `''` into a text column is an empty string and into a timestamp is an error.
 */
function kindOf(declared: string | undefined, sqlType: string): ColumnKind {
  const known: ColumnKind[] = [
    'integer',
    'number',
    'bigint',
    'string',
    'boolean',
    'json',
    'buffer',
  ]
  const kind = known.find(k => k === declared) ?? 'string'
  if (kind === 'string' && RX_DATE_TYPE.test(sqlType.trim())) return 'date'
  return kind
}

function metaOf(
  constraint: ColumnConstraint | undefined,
  schemaColumn: TableDetails['columns'][number],
): ColumnMeta {
  return {
    kind: kindOf(constraint?.type, schemaColumn.type ?? ''),
    // `getConstraints()` when it says anything, `getSchema()`'s NOT NULL flag
    // otherwise. Both are the database's own answer; the first is the richer
    // one and the second is never absent.
    nullable: constraint?.nullable ?? !schemaColumn.notnull,
    length: constraint?.length,
    enum: constraint?._enum,
    // `in`, not `!== undefined`: `DEFAULT NULL` is a default, and it is filed
    // as `default: null`.
    hasDefault: constraint ? 'default' in constraint : false,
    primary: constraint?.primary ?? schemaColumn.pk,
    autoIncrement: constraint?.autoIncrement,
  }
}

/**
 * Every table the connection has, with its identity resolved.
 *
 * Three round trips, taken per request rather than cached. Convention 6 forbids
 * an unbounded module cache, and a bounded one would be worse than none here:
 * the wrong entry is not a slow response, it is a write addressed by a key the
 * table no longer has. Schema introspection is also exactly what the explorer's
 * own `/api/_db/schema` call already costs, so a write pays what a page load
 * pays.
 */
export async function introspect(): Promise<Map<string, TableFacts>> {
  const [schema, constraints, indexes] = await Promise.all([
    connection.getSchema(),
    connection.getConstraints(),
    connection.getIndexes(),
  ])

  const byTable = new Map<string, TableFacts>()
  for (const table of schema) {
    const camel = Case.camel(table.name)
    const tableConstraints = (constraints[camel] ?? {}) as TableConstraints
    const raw = tableConstraints as Record<string, unknown>

    const tableIndexes = Object.entries(indexes)
      .filter(([, index]) => index.table === camel)
      .map(([name, index]) => ({
        name,
        type: index.type,
        cols: index.cols,
      }))

    const identity = describeIdentity({
      name: table.name,
      constraints: tableConstraints,
      indexes: tableIndexes,
      columns: table.columns.map(c => c.name),
    })

    const columns = table.columns.map(column => {
      const columnCamel = Case.camel(column.name)
      const constraint = isColumnKey(columnCamel)
        ? (raw[columnCamel] as ColumnConstraint | undefined)
        : undefined
      return {
        name: column.name,
        camel: columnCamel,
        sqlType: column.type ?? '',
        meta: metaOf(constraint, column),
      }
    })

    const identityCols = new Set(identity.cols)
    const label =
      columns.find(c => c.meta.kind === 'string' && !identityCols.has(c.name))
        ?.name ?? null

    byTable.set(table.name, {
      name: table.name,
      camel,
      isView: typeof raw._view === 'string',
      rowCount: table.rowCount,
      columns,
      byName: new Map(columns.map(c => [c.name, c])),
      identity,
      label,
    })
  }

  return byTable
}
