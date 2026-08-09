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

/**
 * A declared table: the name columns qualify against, the table actually read
 * from, and the columns themselves.
 *
 * **Was `TableDef`, and the rename is the point.** `schema-util.ts` exports a
 * `TableDef<T, N, O>` describing a *column* — and that is the one every
 * internal call site, every test and every schema file means. Both were public,
 * and the root barrel re-exported *this* one, so `import type { TableDef } from
 * '@bakery/orm'` handed you a table where you asked for a column. Nothing
 * errored at the import, and nothing errored until you tried to use it.
 *
 * `TableRef` also says what it is, and pairs with `TableColumn` below.
 */
export interface TableRef<
  N extends string = string,
  C extends ColumnMap = ColumnMap,
> {
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
): TableRef<N, C> & { readonly [K in keyof C]: TableColumn<N, K & string> } {
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
): TableRef<N, C & { _view: string }> & {
  readonly [K in keyof C]: TableColumn<N, K & string>
}
/**
 * A view over one table, borrowing its columns.
 *
 *     export const activeUsers = view('active_users', users, 'SELECT * FROM users WHERE active = 1')
 *
 * The filtered-view case, which is the common one: the shape is the source
 * table's, so restating it is duplication that nothing checks — declare a
 * column the `SELECT` does not return and you find out at query time.
 *
 * The source is a **value**, not a type argument, and that is forced rather
 * than chosen. `view<typeof users>(name, body)` cannot work: TypeScript stops
 * inferring the *remaining* type parameters as soon as one is supplied
 * explicitly, so `N` would fall back to `string` and the view's name would stop
 * being a literal. `__table` is what `InferConstraints` keys the schema map on,
 * so that name degrading takes `InferViews` with it — and since
 * `Mutation.Tables` now excludes views, `Exclude<…, string>` is `never` and
 * *every* mutation stops compiling. Passing the table keeps both inferred.
 *
 * Projecting a subset? Use the three-argument form and name the columns.
 */
export function view<N extends string, C extends ColumnMap>(
  name: N,
  source: TableRef<string, C>,
  body: string,
): TableRef<N, C & { _view: string }> & {
  readonly [K in keyof C]: TableColumn<N, K & string>
}
/**
 * A view described by an interface rather than by column builders.
 *
 *     export interface ActiveUsersView {
 *       id: number
 *       name: string
 *     }
 *
 *     export const activeUsers = view<'active_users', ActiveUsersView>(
 *       'active_users',
 *       'SELECT id, name FROM users WHERE active = 1',
 *     )
 *
 * This is what `db:sync --choose=db` writes into `orm/views.ts`, and it is the
 * honest shape for a view: **a view has no column DDL.** `CREATE VIEW x AS
 * SELECT …` declares no types, and the sync engine only ever reads the body —
 * `createView(name, sql)` takes nothing else, and the diff compares the two
 * bodies as text. So a view's columns exist purely to give it a row type, and
 * writing `Field.Varchar(64)` there would imply a width the database neither
 * stores nor enforces.
 *
 * **Both type arguments are given, and that is forced.** TypeScript stops
 * inferring the remaining type parameters as soon as one is supplied, so
 * `view<ActiveUsersView>(name, body)` would leave `N` as `string` — and `N` is
 * what `TablesOf` re-keys the schema map on, so the whole map collapses to an
 * index signature and every mutation stops compiling. Naming both keeps it a
 * literal. In generated code the repetition costs nothing.
 *
 * Column references still work — `activeUsers.id` — even though the keys are
 * known only to the type. See the implementation.
 */
export function view<N extends string, T>(
  name: N,
  body: string,
): TableRef<N, ViewColumns<T>> & {
  readonly [K in keyof T]: TableColumn<N, K & string>
}
export function view(
  name: string,
  bodyOrSource: string | TableRef,
  columnsOrBody?: ColumnMap | string,
): unknown {
  // Two arguments means the interface form: the columns are type-only, so the
  // runtime object carries the body and nothing else.
  if (columnsOrBody === undefined && typeof bodyOrSource === 'string') {
    return viewFromType(name, bodyOrSource)
  }
  // The second argument tells the two forms apart: a `SELECT` string, or the
  // table to borrow columns from.
  const derived = typeof bodyOrSource !== 'string'
  const body = derived ? (columnsOrBody as string) : bodyOrSource
  const columns = derived
    ? (bodyOrSource as TableRef).__columns
    : (columnsOrBody as ColumnMap)
  return viewImpl(name, body, columns)
}

/**
 * A row interface, as the descriptor map `ExtractTableTypes` reads.
 *
 * One `{ type: T[K] }` per property — which is all a descriptor needs now that
 * `type` carries the row type — plus the `_view` marker that makes
 * `ExtractViews` classify it as a view.
 */
type ViewColumns<T> = { [K in keyof T]-?: { type: T[K] } } & { _view: string }

/**
 * The interface form's runtime value.
 *
 * The column keys live only in the type, so the refs cannot be enumerated the
 * way `table()` enumerates them. A `Proxy` answers for any property instead,
 * which is exactly as correct here: a ref is `{ __table, __column }` computed
 * from the key, and the key is whatever was asked for. The type is what
 * restricts *which* keys are askable.
 *
 * `__table`, `__source` and `__columns` are answered from the real object so
 * `collectConstraints` and the sync engine see what they expect.
 */
function viewFromType(name: string, body: string): unknown {
  const base: Record<string, unknown> = {
    __table: name,
    __source: name,
    __columns: { _view: body },
  }
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop in target) {
        return Reflect.get(target, prop)
      }
      return { __table: name, __column: prop }
    },
    // Without this the sync engine's `Object.keys`/spread would see the three
    // internals as ordinary columns.
    ownKeys: target => Reflect.ownKeys(target),
  })
}

function viewImpl<N extends string, C extends ColumnMap>(
  name: N,
  body: string,
  columns: C,
): TableRef<N, C & { _view: string }> & {
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
  base: TableRef<N, C>,
  name: A,
): TableRef<A, C> & { readonly [K in keyof C]: TableColumn<A, K & string> } {
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

/** Every `TableRef` exported by a module, keyed by its declared table name. */
type TablesOf<M> = {
  [K in keyof M as M[K] extends TableRef<infer N, any> ? N : never]: M[K]
}

/**
 * The `constraints` shape the sync engine already consumes, rebuilt from
 * table values. Keeping this identical is what lets the diff engine, the
 * generator and the query builder stay untouched.
 */
export type InferConstraints<M> = {
  [N in keyof TablesOf<M>]: TablesOf<M>[N] extends TableRef<any, infer C>
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
    const def = exported as TableRef
    if (typeof def.__table !== 'string' || !def.__columns) continue

    // Skip aliases. An alias is a query-time view of an existing table, and
    // collecting one would tell the sync engine to CREATE a table named after
    // it — so `alias(users, 'author')` would try to build an `author` table.
    if (def.__source !== def.__table) continue

    constraints[def.__table] = def.__columns
  }

  return constraints
}

/**
 * The row type of a `table()` or `view()`, for naming.
 *
 *     export type ActiveUsersView = RowOf<typeof activeUsers>
 *     //     ^ { id: number; name: string }
 *
 * TypeScript cannot mint a *named* interface from a value — a name has to be
 * written somewhere — so this is the one line that does it, and it stays
 * correct when the declaration changes because it is derived rather than
 * copied. A hand-written `interface ActiveUsersView` would be a second source
 * of truth that nothing checks against the first.
 *
 * `_view` is filtered out by `ExtractTableTypes`, so a view's row type is its
 * columns and nothing else.
 */
export type RowOf<T extends TableRef> = ExtractTableTypes<
  { t: T['__columns'] },
  't'
>

/**
 * What an `INSERT` into it accepts: {@link RowOf} with the optional columns
 * made optional.
 *
 *     export type NewUser = InsertOf<typeof users>
 *     //     ^ { name: string; id?: number; createdAt?: number }
 */
export type InsertOf<T extends TableRef> = Omit<
  RowOf<T>,
  ExtractOptionals<{ t: T['__columns'] }, 't'> & keyof RowOf<T>
> &
  Partial<
    Pick<
      RowOf<T>,
      ExtractOptionals<{ t: T['__columns'] }, 't'> & keyof RowOf<T>
    >
  >
