import { primary, value } from './schema-util'

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
