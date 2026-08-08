import { primary, value } from './schema-util'
import type * as SyncTypes from './sync/types'

/**
 * `Field` — the column vocabulary, namespaced so it is discoverable.
 *
 * `value('string', null, true, false, false)` requires remembering both a type
 * string and the meaning of four positional booleans; `Field.String(null)` does
 * not, and typing `Field.` lists everything a column can be.
 *
 * **Every builder is a thin wrapper over `value()`, and that is the design.**
 * The generics pass straight through, so `InferSchema`, `InferOptionals` and
 * the sync engine receive exactly the objects they receive today — this adds a
 * vocabulary, not a second code path, so it cannot drift from `value()` or
 * regress inference. `value()` remains the primitive and stays exported for
 * anything `Field` does not spell.
 *
 * Two conventions carried over rather than invented:
 *
 * - **`null` as the default means nullable**, exactly as `value('string', null)`
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
   */
  Primary: () => primary(),

  /** A whole number. */
  Int: <D extends number | null | undefined = undefined>(d?: D) =>
    value('integer', d),

  /**
   * A fractional number — `DOUBLE` on MySQL, `DOUBLE PRECISION` on Postgres,
   * `REAL` on SQLite.
   *
   * Named `Float` rather than mirroring the underlying `'number'` type string,
   * because `number` says nothing about precision and reads as "any number"
   * next to `Int`.
   */
  Float: <D extends number | null | undefined = undefined>(d?: D) =>
    value('number', d),

  /** Text. `Text()` and `Varchar()` say which kind; this stays the plain one. */
  String: <D extends string | null | undefined = undefined>(d?: D) =>
    value('string', d),

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
  Text: (nullable?: true) =>
    nullable ? value('string', null) : value('string'),

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
  ) => Object.assign(value('string', d), { length }),

  /**
   * A 64-bit integer — `BIGINT` everywhere.
   *
   * Reads back as a **string** on MySQL and Postgres, which is how they avoid
   * losing precision, and as a **number** on SQLite, which does not: values
   * past 2^53 round. Measured on live servers, not assumed. If you need exact
   * large integers on SQLite, store them as `Varchar`.
   */
  BigInt: <D extends number | null | undefined = undefined>(d?: D) =>
    value('bigint' as any, d as any),

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
  Json: (nullable?: true) =>
    nullable ? value('json' as any, null) : value('json' as any),

  /** True/false — `BOOLEAN` on Postgres, `TINYINT(1)` on MySQL. */
  Bool: <D extends boolean | null | undefined = undefined>(d?: D) =>
    value('boolean', d),

  /** Binary. Always nullable: no dialect here takes a binary literal default. */
  Blob: () => value('buffer', null),

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
  Foreign: (
    target: { __table: string; __column: string },
    options: {
      nullable?: true
      /** Defaults to NO ACTION, as SQL does. */
      onDelete?: SyncTypes.ForeignKeyAction
      onUpdate?: SyncTypes.ForeignKeyAction
    } = {},
  ) =>
    ({
      // Filled in from the referenced column at load time. `integer` is the
      // placeholder rather than the answer — a schema that somehow reaches an
      // adapter unresolved gets the overwhelmingly common case instead of a
      // column with no type at all.
      type: 'integer',
      ...(options.nullable ? { nullable: true, default: null } : {}),
      _references: {
        table: target.__table,
        column: target.__column,
        onDelete: options.onDelete,
        onUpdate: options.onUpdate,
      },
    }) as any,

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
      nullable ? value('string', null) : value('string', '%uuid%' as const),
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
  Enum: <const V extends readonly string[], D extends V[number] | null | undefined = undefined>(
    values: V,
    d?: D,
  ) =>
    Object.assign(value('string', d as any), {
      // Sized to the longest member so the column cannot be too small to hold
      // a value the CHECK permits.
      length: Math.max(1, ...values.map(v => String(v).length)),
      _enum: [...values] as string[],
    }) as unknown as ReturnType<typeof value<'string', D>> & {
      length: number
      _enum: string[]
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
    createdAt: value('integer', '%dateNow%' as const),
    updatedAt: value('integer', '%dateNow%' as const),
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
      value('integer', d),
    { now: () => value('integer', '%dateNow%' as const) },
  ),
}
