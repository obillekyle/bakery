import { throws } from '@bakery/core/utils/common'
import type { DataTypes, TableDef } from './schema-util'
import type * as SyncTypes from './sync/types'

/**
 * Build a column descriptor.
 *
 * The former `value()` primitive, now private and two arguments shorter.
 * `autoIncrement` and `primary` were positional booleans that only
 * `Field.Primary()` ever set, and it can state them directly — which is the
 * whole reason `value('integer', undefined, false, true, true)` was worth
 * replacing.
 *
 * `n === true`, not `n !== undefined`: treating *any* third argument as
 * "nullable" is a bug this file has already had, where an explicit
 * `false` produced a nullable column. `=== true` also matches what `TableDef`
 * computes from `N extends true`, so the emitted DDL and the inferred row type
 * cannot disagree.
 */
function column<T, N extends boolean = false, O extends boolean = false>(
  sql: DataTypes,
  d?: unknown,
  nullable?: boolean,
): TableDef<T, N, O> {
  const result: Record<string, unknown> = { type: sql }
  if (d !== undefined) result.default = d
  if (nullable === true || d === null) result.nullable = true
  // The runtime object is byte-for-byte what it was before `TableDef` changed
  // shape: `type` holds the dialect name, `optional` is type-level only. That
  // is the whole safety argument for this change — no adapter, no generated
  // file and no stored ledger payload sees any difference.
  return result as unknown as TableDef<T, N, O>
}

/** `T` when the column is NOT NULL, `T | null` when it is nullable. */
type Nullable<T, N extends boolean> = N extends true ? T | null : T

/**
 * Optional on insert when there is a default, or the column is nullable.
 *
 * Computed once here so each builder does not restate it, and so the rule is
 * in one place rather than implied by five `TableDef` arguments.
 */
type OptionalFor<D> = D extends undefined ? false : true

const isColumnValue = (v: unknown): v is ColumnValue =>
  Boolean(v) &&
  typeof v === 'object' &&
  '__table' in (v as any) &&
  '__column' in (v as any)

/**
 * Resolve either calling convention to `{ table, cols }`.
 *
 * The string form — `Field.Index('posts', ['authorId'])` — cannot catch a typo
 * in either argument until sync time, if then. The column form —
 * `Field.Index(posts.authorId)` — carries its own table, so that argument
 * disappears and a mistake becomes a compile error.
 */
function resolveTarget(
  first: string | ColumnValue,
  rest: (string | ColumnValue | string[])[],
): { table: string; cols: string[] } {
  if (isColumnValue(first)) {
    const columns = [first, ...rest.filter(isColumnValue)]
    const tables = new Set(columns.map(c => c.__table))
    if (tables.size > 1) {
      throws(`Constraint spans more than one table: ${[...tables].join(', ')}`)
    }
    return { table: first.__table, cols: columns.map(c => c.__column) }
  }

  const cols = rest[0]
  return {
    table: first,
    cols: Array.isArray(cols) ? cols : [cols as string],
  }
}

/** Referential actions. Both default to `NO ACTION`, as SQL does. */
export interface ForeignKeyActions {
  onDelete?: SyncTypes.ForeignKeyAction
  onUpdate?: SyncTypes.ForeignKeyAction
}

/**
 * The shape `Field.Foreign()` contributes to a row type.
 *
 * Always `integer`, because that is what `Field.Primary()` always is — an
 * `INTEGER PRIMARY KEY AUTOINCREMENT` — and a foreign key exists to point at
 * one. Nullable adds `| null`, which is the only variation worth having.
 *
 * The runtime object still resolves its type from the referenced column (see
 * `Foreign` below), which matters for the rarer case of referencing a
 * non-integer unique column: MySQL refuses a key whose types do not match
 * exactly, so the DDL has to follow the target even where the row type says
 * `number`.
 */
type ForeignDef<N extends true | undefined> = TableDef<
  N extends true ? number | null : number,
  N extends true ? true : false,
  N extends true ? true : false
>

/** What `Field.Index` / `Field.Unique` accept — a column produced by `table()`. */
type ColumnValue = { __table: string; __column: string }

/**
 * What `Field.Enum` accepts: a literal array, or a TypeScript string enum.
 *
 * A string enum is an ordinary object at runtime (`{ Draft: 'draft' }`), so
 * both forms reduce to the same list of members — `Object.values` for the
 * object, the tuple itself for the array.
 *
 * **String enums only.** A *numeric* enum compiles to an object with a reverse
 * mapping (`{ 0: 'A', A: 0 }`), so its `Object.values` are half names and half
 * numbers, and the column here is text with a `CHECK` over string literals.
 * Excluded by the constraint, and again at runtime for callers arriving from
 * JavaScript, rather than quietly producing a column constrained to the wrong
 * four values.
 */
type EnumSource = readonly string[] | Record<string, string>

/** The member union of either form. */
type EnumValues<V> = V extends readonly (infer U extends string)[]
  ? U
  : V[keyof V]

/**
 * `Field` — the column vocabulary, namespaced so it is discoverable.
 *
 * This replaced `value('string', null, true, false, false)`, which required
 * remembering a type string *and* the meaning of four positional booleans.
 * `Field.String(null)` needs neither, and typing `Field.` lists everything a
 * column can be.
 *
 * **`Field` is now the whole vocabulary, not sugar over one.** `value`,
 * `primary`, `index`, `unique` and `foreign` are gone; the construction they
 * did lives in `column()` and `resolveTarget()` above, private to this file.
 * What the sync engine and the type inference consume is unchanged — plain
 * descriptor objects — so this moved the API without moving the contract.
 *
 * The one shape deliberately left unspellable is **nullable *and* defaulted to
 * something other than null**, because a null default is how you say nullable.
 * Write that one as a literal (`{ type: 'integer', default: 0, nullable: true }`),
 * which is what the schema generator emits for it too.
 *
 * Two conventions worth stating:
 *
 * - **`null` as the default means nullable**, as in `Field.String(null)`.
 *   does. `Field.String()` is NOT NULL with no default; `Field.String('')` is
 *   NOT NULL defaulting to empty; `Field.String(null)` is nullable.
 * - **Modifiers are not chained.** A fluent `.nullable().primary()` has to
 *   return a builder that is also a `TableDef`, and that intersection is what
 *   broke inference when this was prototyped: `email` came out `string` rather
 *   than `string | null`. The named constructors below cover the real cases
 *   without the type gymnastics.
 */
export const Field = {
  /**
   * `INTEGER PRIMARY KEY AUTOINCREMENT` — the id column, spelled once.
   *
   * The single most repeated line in any schema, and the one most likely to be
   * written wrong by hand: `value('integer', undefined, false, true, true)`.
   *
   * **Always an integer.** There is no string- or UUID-keyed variant here on
   * purpose: `Field.Uuid()` gives you a generated UUID column, and pairing it
   * with `Field.Unique()` is how you key a table on one. Keeping `Primary()` to
   * exactly one meaning is what lets `Field.Foreign()` state its own type
   * instead of inferring it.
   */
  Primary: () =>
    ({ type: 'integer', autoIncrement: true, primary: true }) as unknown as TableDef<
      number,
      false,
      true
    >,

  /** A whole number. */
  Int: <D extends number | null | undefined = undefined>(d?: D) =>
    column<Nullable<number, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('integer', d),

  /**
   * A fractional number — `DOUBLE` on MySQL, `DOUBLE PRECISION` on Postgres,
   * `REAL` on SQLite.
   *
   * Named `Float` rather than mirroring the underlying `'number'` type string,
   * because `number` says nothing about precision and reads as "any number"
   * next to `Int`.
   */
  Float: <D extends number | null | undefined = undefined>(d?: D) =>
    column<Nullable<number, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('number', d),

  /** Text. `Text()` and `Varchar()` say which kind; this stays the plain one. */
  String: <D extends string | null | undefined = undefined>(d?: D) =>
    column<Nullable<string, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('string', d),

  /**
   * Unbounded text — `TEXT` on every dialect.
   *
   * **MySQL rejects a literal `DEFAULT` on TEXT**, so this takes no default.
   * That is not an omission: `Field.String('')` emits
   * `TEXT NOT NULL DEFAULT ''`, which MySQL refuses outright with "BLOB, TEXT,
   * GEOMETRY or JSON column can't have a default value" — the shipped schema
   * template could not `db:sync` against MySQL because of exactly this. Use
   * `Varchar` when you need a default.
   */
  // Overloaded, so each call has one concrete type. A bare ternary infers the
  // *union* of both branches, and `Field.Text(true).nullable` then fails to
  // compile because `nullable` is absent from the other member.
  Text: ((nullable?: true) =>
    nullable ? column('string', null) : column('string')) as {
    (): TableDef<string, false, false>
    (nullable: true): TableDef<string | null, true, true>
  },

  /**
   * Sized text — `VARCHAR(n)`, and the answer to TEXT's default problem, since
   * every dialect accepts a default on a sized column.
   *
   *     slug: Field.Varchar(255, ''),
   *
   * SQLite has no real `VARCHAR` — all text is TEXT affinity — but it stores
   * the declared type verbatim and reads it back, so one schema round-trips on
   * all three.
   *
   * `length` is not part of the column diff, so **widening a Varchar does not
   * migrate on its own**; see `ColumnConstraint.length` for why that is
   * deliberate rather than missing.
   */
  Varchar: <D extends string | null | undefined = undefined>(
    length: number,
    d?: D,
  ) =>
    Object.assign(
      column<Nullable<string, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('string', d),
      { length },
    ),

  /**
   * A 64-bit integer — `BIGINT` everywhere.
   *
   * Reads back as a **string** on MySQL and Postgres, which is how they avoid
   * losing precision, and as a **number** on SQLite, which does not: values
   * past 2^53 round. Measured on live servers, not assumed. If you need exact
   * large integers on SQLite, store them as `Varchar`.
   */
  BigInt: <D extends number | null | undefined = undefined>(d?: D) =>
    column<Nullable<number, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('bigint' as any, d),

  /**
   * A JSON document — `JSON` on MySQL, `JSONB` on Postgres, a `JSON`-declared
   * text column on SQLite.
   *
   * MySQL and Postgres parse it into an object on read; SQLite hands back the
   * raw string. The row type is therefore `unknown` — narrow it where you use
   * it rather than trusting a type that would be wrong on one of the three.
   *
   * Takes no default, for the same reason `Text` does not: MySQL refuses a
   * literal default on a JSON column.
   */
  // Overloaded for the same reason as `Text` above.
  Json: ((nullable?: true) =>
    nullable ? column('json' as any, null) : column('json' as any)) as {
    (): TableDef<unknown, false, false>
    (nullable: true): TableDef<unknown, true, true>
  },

  /** True/false — `BOOLEAN` on Postgres, `TINYINT(1)` on MySQL. */
  Bool: <D extends boolean | null | undefined = undefined>(d?: D) =>
    column<Nullable<boolean, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('boolean', d),

  /** Binary. Always nullable: no dialect here takes a binary literal default. */
  Blob: () => column<Buffer | null, true, true>('buffer', null),

  /**
   * A column that references another table's column.
   *
   *     export const posts = table('posts', {
   *       id:       Field.Primary(),
   *       authorId: Field.Foreign(users.id),
   *     })
   *
   * Replaces a separate `foreign(posts.authorId).references(users.id)` export
   * for the common single-column case, and puts the reference on the column it
   * constrains rather than somewhere else in the file where it can be forgotten
   * or left unexported.
   *
   * **The column's type is copied from the target, not declared here**, and
   * that is the real reason to prefer this form. MySQL refuses a foreign key
   * whose column type does not match the referenced key *exactly* — an
   * `INT` child against a `BIGINT` parent is rejected outright — and that
   * mismatch is invisible in a schema where the two columns are declared pages
   * apart. Resolution happens in `resolveColumnForeignKeys()`, where the whole
   * schema is in scope, so the two cannot disagree.
   *
   * Composite keys still use `foreign()`: a multi-column reference has no
   * single column to hang off.
   */
  Foreign: Object.assign(
    <N extends true | undefined = undefined>(
    target: ColumnValue,
    options: {
      nullable?: N
      /** Defaults to NO ACTION, as SQL does. */
      onDelete?: SyncTypes.ForeignKeyAction
      onUpdate?: SyncTypes.ForeignKeyAction
    } = {},
  ) =>
    ({
      // `integer` in the row type, always — see `ForeignDef`. At *runtime* the
      // type is still overwritten from the referenced column by
      // `resolveColumnForeignKeys()`, because MySQL refuses a key whose column
      // type does not match the target exactly. For the ordinary case — a key
      // pointing at a `Field.Primary()` — the two agree and there is nothing to
      // reconcile.
      type: 'integer',
      ...(options.nullable ? { nullable: true, default: null } : {}),
      _references: {
        table: target.__table,
        column: target.__column,
        onDelete: options.onDelete,
        onUpdate: options.onUpdate,
      },
    }) as unknown as ForeignDef<N>,
    {
      /**
       * A key spanning more than one column.
       *
       *     Field.Foreign.composite(items.orderId, items.sku)
       *       .references(orders.id, orders.sku, { onDelete: 'CASCADE' })
       *
       * Separate from `Field.Foreign()` rather than an overload of it, because
       * the two return different *kinds* of thing: `Field.Foreign(users.id)` is
       * a column definition that goes inside a table, and this is a table-level
       * constraint that goes beside one. Distinguishing them by argument count
       * would make two calls that look alike mean different things.
       *
       * Variadic on both sides. `cols`/`refCols` have always been arrays and
       * every adapter already emits a multi-column
       * `FOREIGN KEY (a, b) REFERENCES t (x, y)`.
       */
      composite: (...columns: ColumnValue[]) => {
        // Validated here rather than in `references`, so a mistake is caught on
        // the side that made it.
        if (!columns.length) throws('Field.Foreign.composite() needs a column')
        const table = columns[0]!.__table
        if (columns.some(c => c.__table !== table))
          throws(
            `Field.Foreign.composite() columns must all belong to one table; got ${[
              ...new Set(columns.map(c => c.__table)),
            ].join(', ')}.`,
          )

        return {
          references(...args: (ColumnValue | ForeignKeyActions)[]): any {
            const targets = args.filter(isColumnValue) as ColumnValue[]
            // The options object, when present, is the only non-column argument.
            const actions =
              (args.find(a => a && !isColumnValue(a)) as
                | ForeignKeyActions
                | undefined) ?? {}

            if (!targets.length)
              throws('Field.Foreign.composite().references() needs a target column')
            if (targets.length !== columns.length)
              throws(
                `Field.Foreign.composite() references the wrong number of columns: ` +
                  `${columns.length} on ${table}, ${targets.length} on the target. ` +
                  'A composite key must name the same count on both sides, in the ' +
                  'same order.',
              )
            const refTable = targets[0]!.__table
            if (targets.some(t => t.__table !== refTable))
              throws(
                `Field.Foreign.composite().references() targets must all belong to one table; got ${[
                  ...new Set(targets.map(t => t.__table)),
                ].join(', ')}.`,
              )

            return {
              table,
              type: 'foreign',
              cols: columns.map(c => c.__column),
              refTable,
              refCols: targets.map(t => t.__column),
              onDelete: actions.onDelete,
              onUpdate: actions.onUpdate,
            }
          },
        }
      },
    },
  ),

  /**
   * A non-unique index.
   *
   *     Field.Index(posts.authorId)                    // table() columns
   *     Field.Index(posts.authorId, posts.createdAt)   // composite, in order
   *     Field.Index('posts', ['authorId'])             // DBInfo layout
   *
   * The column form carries its own table, so there is no separate table
   * argument to get wrong; the string form exists because the `DBInfo`
   * namespace layout has no `table()` values to point at. Several columns make
   * one composite index, in the order given — which is the order that decides
   * which queries it can serve.
   *
   * A direct alias of `index()` rather than a wrapper, so the two cannot drift
   * and both call signatures come along for free.
   */
  Index: ((first: any, ...rest: any[]) => ({
    type: 'index',
    ...resolveTarget(first, rest),
  })) as {
    (table: string, cols: string | string[]): any
    (...cols: ColumnValue[]): any
  },

  /**
   * A uniqueness constraint. Same call shapes as {@link Field.Index}.
   *
   * Also what makes a column a legal foreign-key *target*: SQL requires the
   * referenced column to be a PRIMARY KEY or carry a UNIQUE index, and without
   * one MySQL and Postgres refuse the CREATE while SQLite accepts it and then
   * fails every insert with "foreign key mismatch".
   */
  Unique: ((first: any, ...rest: any[]) => ({
    type: 'unique',
    ...resolveTarget(first, rest),
  })) as {
    (table: string, cols: string | string[]): any
    (...cols: ColumnValue[]): any
  },

  /**
   * A UUID, generated by the database — `CHAR(36)` sized text with a
   * per-dialect default expression.
   *
   *     id: Field.Uuid(),
   *
   * `gen_random_uuid()` on Postgres, `UUID()` on MySQL, and
   * `lower(hex(randomblob(16)))` shaped into the canonical form on SQLite,
   * which has no UUID function of its own. All three round-trip through the
   * `%uuid%` marker, the same way `Field.Date.now()` round-trips `%dateNow%` —
   * without the read-back half the database reports its own expression, the
   * schema says `%uuid%`, and the column rebuilds on every sync forever.
   *
   * Not a primary key by itself. `Field.Uuid()` next to no `Field.Primary()`
   * gives a table with a unique-looking column and no key; add `unique()` or
   * use it as one deliberately.
   */
  Uuid: (nullable?: true) =>
    Object.assign(
      nullable
        ? column<string | null, true, true>('string', null)
        : column<string, false, true>('string', '%uuid%'),
      { length: 36 },
    ),

  /**
   * Text restricted to a fixed set of values, with the *union* as its type.
   *
   *     status: Field.Enum(['draft', 'published'] as const, 'draft'),
   *
   * The row type is `'draft' | 'published'`, not `string`, so a typo is a
   * compile error at the call site rather than a row nobody notices. `as const`
   * is what makes that work; without it TypeScript widens the array to
   * `string[]` and the column is just text.
   *
   * Enforced in the database too, and **the same way on all three dialects**:
   * a `CHECK (col IN (…))`. MySQL has a native `ENUM` and this deliberately
   * does not use it — a value rejected by MySQL and accepted by SQLite means
   * an app that behaves differently depending on where it runs, which is worse
   * than either choice made consistently.
   *
   * The members are **not part of the column diff** — see
   * `ColumnConstraint._enum`. Adding or removing one does not migrate on its
   * own; the table has to be rebuilt for the CHECK to change.
   */
  Enum: <
    const V extends EnumSource,
    D extends EnumValues<V> | null | undefined = undefined,
  >(
    values: V,
    d?: D,
  ) => {
    const members = (
      Array.isArray(values) ? [...values] : Object.values(values)
    ) as string[]
    if (!members.length) throws('Field.Enum() needs at least one member')
    const bad = members.find(m => typeof m !== 'string')
    if (bad !== undefined) {
      throws(
        'Field.Enum() takes a string enum or an array of strings. A numeric ' +
          'enum reverse-maps its members, so its values are half names and ' +
          'half numbers — use Field.Int() and validate in your code, or give ' +
          'the enum string values.',
      )
    }
    return Object.assign(column('string', d as any), {
      // Sized to the longest member so the column cannot be too small to hold
      // a value the CHECK permits.
      length: Math.max(1, ...members.map(m => m.length)),
      // Typed as the member union, not `string[]`: `ExtractTableTypes` reads the
      // element type out of here to build the row type, so widening it would
      // silently turn the column back into plain text.
      _enum: members,
      // The enum union rides in `type` now, so it reaches the row type by the
      // ordinary path. `ExtractTableTypes` no longer needs to read `_enum`
      // *before* `type` to stop `TypeMap` widening it back to `string`.
    }) as unknown as TableDef<
      D extends null ? EnumValues<V> | null : EnumValues<V>,
      D extends null ? true : false,
      D extends undefined ? false : true
    > & { length: number; _enum: readonly EnumValues<V>[] }
  },

  /**
   * The `createdAt` / `updatedAt` pair, spread into a table.
   *
   *     users: {
   *       id: Field.Primary(),
   *       ...Field.Timestamps(),
   *     }
   *
   * Both are Unix seconds and both default to insert time.
   *
   * **`updatedAt` is not auto-maintained on write, and that is a deliberate
   * limit rather than an oversight.** Doing it silently needs the query layer
   * to know which tables have the column, and the query layer has no runtime
   * view of the schema at all — `schema.ts` is loaded by the sync engine, not
   * by the ORM. The alternatives were a `hasCol` probe on every UPDATE, or
   * stamping a column that might not exist. Stamp it yourself:
   *
   *     DB.Update('users').set({ name, updatedAt: Field.now() }).where(...)
   */
  Timestamps: () => ({
    createdAt: column<number, false, true>('integer', '%dateNow%'),
    updatedAt: column<number, false, true>('integer', '%dateNow%'),
  }),

  /**
   * The current time as Unix **seconds**, for a value position.
   *
   * A plain number, so it binds as an ordinary parameter and needs no dialect
   * handling — unlike `%dateNow%`, which is a DDL default marker and means
   * nothing in an INSERT or UPDATE.
   */
  now: () => Math.floor(Date.now() / 1000),

  /**
   * A timestamp in Unix **seconds**, stored as an integer.
   *
   * `Field.Date.now()` fills in insert time via the `%dateNow%` marker, which
   * each adapter renders in its own dialect. Seconds rather than milliseconds
   * because that is what `%dateNow%` already produces on all three.
   */
  Date: Object.assign(
    <D extends number | null | undefined = undefined>(d?: D) =>
      column<Nullable<number, D extends null ? true : false>, D extends null ? true : false, OptionalFor<D>>('integer', d),
    // Optional on insert: the database supplies it.
    { now: () => column<number, false, true>('integer', '%dateNow%') },
  ),
}
