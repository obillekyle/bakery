import type {
  ExtractOptionals,
  ExtractTableTypes,
  ExtractViews,
} from './schema-util'

/**
 * Prototype: tables as values.
 *
 * Today a schema is one `constraints` object plus a hand-written `DBSchema`
 * type, and everything that references a table — indexes, foreign keys, query
 * columns — does so by string. Typos surface at sync time, or not at all.
 *
 * Here a table is a value carrying its own name and columns, so `indexes.ts`
 * and `foreign.ts` can import it, rename-symbol works across files, and an
 * identifier reaching SQL is one the framework constructed rather than one a
 * caller typed.
 *
 * The column descriptors are unchanged — the `Field` builders and the
 * `ExtractTableTypes` mapping are reused as-is, so this is a restructuring of
 * how tables are *declared*, not of how their types are computed. That is what
 * keeps `DB.table('users')` autocompleting exactly as it does now: the derived
 * `DBSchema` has the same shape the hand-written one had.
 */

/** Columns as declared: `{ id: Field.Primary(), name: Field.Text(true) }`. */
export type ColumnMap = Record<string, unknown>

export interface TableDef<N extends string = string, C extends ColumnMap = ColumnMap> {
  /** The name columns qualify against — the alias, when aliased. */
  readonly __table: N
  /** The real table to read FROM. Differs from `__table` only for an alias. */
  readonly __source: string
  readonly __columns: C
}

/**
 * A reference to one column, carrying its table. This is the value that
 * replaces the `'users.id'` string — `qId` receives structured data rather
 * than text that has to be validated before it can be trusted.
 */
export interface TableColumn<
  N extends string = string,
  K extends string = string,
> {
  readonly __table: N
  readonly __column: K
}

/**
 * Declare a table. The name is explicit rather than inferred from the export
 * binding: deriving it would need a build step or a Proxy, and neither is
 * worth the indirection for one string.
 */
export function table<N extends string, C extends ColumnMap>(
  name: N,
  columns: C,
): TableDef<N, C> & { readonly [K in keyof C]: TableColumn<N, K & string> } {
  const refs = Object.fromEntries(
    Object.keys(columns).map(key => [key, { __table: name, __column: key }]),
  )

  return Object.assign(Object.create(null), refs, {
    __table: name,
    __source: name,
    __columns: columns,
  })
}

/**
 * Declare a view — a stored `SELECT` the database treats as a table.
 *
 *     export const activeUsers = view(
 *       'active_users',
 *       'SELECT id, name FROM users WHERE active = 1',
 *       { id: Field.Primary(), name: Field.Varchar(64) },
 *     )
 *
 * The columns are the shape the `SELECT` returns. They are declared rather than
 * inferred because nothing here parses SQL, and they are what gives the view a
 * row type — reading from it is typed exactly like reading a table.
 *
 * **Writes are rejected at compile time.** `InferViews` collects these names and
 * `Mutation.Tables` excludes them, so `DB.Insert.into('active_users')` does not
 * typecheck. A view is a `SELECT`; the database would refuse the write anyway,
 * and refusing it earlier is strictly better.
 *
 * `db:sync` emits `CREATE VIEW`, diffs the body as normalised text, and drops
 * and recreates the view when it changes — views hold no data, so recreating is
 * free and there is no migration to plan.
 *
 * Previously declarable only in the older `DBInfo` layout, or here by writing
 * `_view` into a `table()` call and casting. The key is the same; this just
 * types it.
 */
export function view<N extends string, C extends ColumnMap>(
  name: N,
  body: string,
  columns: C,
): TableDef<N, C & { _view: string }> & {
  readonly [K in keyof C]: TableColumn<N, K & string>
} {
  // `_view` rides inside `__columns` because that is the object the sync engine
  // receives, and it is where `ExtractViews` and the adapters already look for
  // it. Adding a sibling field would mean teaching `collectConstraints`, the
  // diff and three adapters about a second place to check.
  //
  // It has to be in `__columns`'s *declared type* too, not only at runtime:
  // `ExtractViews` is what `InferViews` reads and what `Mutation.Tables`
  // excludes, so erasing `_view` from the type left writes to a view
  // compiling — the exact thing declaring one is supposed to prevent.
  // `ExtractTableTypes` filters the key out of the row type separately.
  return Object.assign(table(name, columns), {
    __columns: { _view: body, ...columns },
  }) as any
}

/**
 * Alias a table for a join, so the same table can appear twice in one query.
 *
 * This is the object-form answer to `join('users.id', ..., 'author')` followed
 * by `'author.username'`. It is not a downgrade: with strings the alias is
 * declared in one place and referenced as text everywhere else, and nothing
 * checks that they agree. Here the alias *is* the value you use, so a typo is
 * a compile error and rename-symbol reaches every usage.
 *
 * Columns re-qualify against the alias while `__source` remembers the real
 * table, which is what lets the builder emit `FROM users AS author`.
 */
export function alias<N extends string, C extends ColumnMap, A extends string>(
  base: TableDef<N, C>,
  name: A,
): TableDef<A, C> & { readonly [K in keyof C]: TableColumn<A, K & string> } {
  const refs = Object.fromEntries(
    Object.keys(base.__columns).map(key => [
      key,
      { __table: name, __column: key },
    ]),
  )

  return Object.assign(Object.create(null), refs, {
    __table: name,
    __source: base.__source,
    __columns: base.__columns,
  })
}

/** Every `TableDef` exported by a module, keyed by its declared table name. */
type TablesOf<M> = {
  [K in keyof M as M[K] extends TableDef<infer N, any> ? N : never]: M[K]
}

/**
 * The `constraints` shape the sync engine already consumes, rebuilt from
 * table values. Keeping this identical is what lets the diff engine, the
 * generator and the query builder stay untouched.
 */
export type InferConstraints<M> = {
  [N in keyof TablesOf<M>]: TablesOf<M>[N] extends TableDef<any, infer C>
    ? C
    : never
}

/** Row types — the derived replacement for a hand-written `DBSchema`. */
export type InferSchema<M> = {
  [N in keyof InferConstraints<M>]: ExtractTableTypes<InferConstraints<M>, N>
}

/** Columns optional on insert, derived the same way. */
export type InferOptionals<M> = {
  [N in keyof InferConstraints<M>]: ExtractOptionals<InferConstraints<M>, N>
}

/** View names, for exclusion from mutation targets. */
export type InferViews<M> = ExtractViews<InferConstraints<M>>

/** Collect the runtime constraints object the sync engine loads. */
export function collectConstraints(module: Record<string, unknown>) {
  const constraints: Record<string, unknown> = {}

  for (const exported of Object.values(module)) {
    if (!exported || typeof exported !== 'object') continue
    const def = exported as TableDef
    if (typeof def.__table !== 'string' || !def.__columns) continue

    // Skip aliases. An alias is a query-time view of an existing table, and
    // collecting one would tell the sync engine to CREATE a table named after
    // it — so `alias(users, 'author')` would try to build an `author` table.
    if (def.__source !== def.__table) continue

    constraints[def.__table] = def.__columns
  }

  return constraints
}
