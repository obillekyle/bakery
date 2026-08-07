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

  /** Text. Note the MySQL caveat on defaults — see the note below. */
  String: <D extends string | null | undefined = undefined>(d?: D) =>
    value('string', d),

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
