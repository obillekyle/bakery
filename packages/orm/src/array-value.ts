/**
 * A Postgres array, bound as one parameter: what `DB.array([...])` makes.
 *
 * Needed because Bun cannot bind a JavaScript array to a Postgres array
 * parameter. Measured: into `text[]` it fails with `22P02 malformed array
 * literal: "x,y"`, into `int4[]` with `08P01 insufficient data left in
 * message`, explicit `::int4[]` cast or not, and the same in `@>`, `&&` and
 * `= ANY(?)`. An array literal sent as text binds in all of those places with
 * no cast, for text, int4, int8, jsonb and uuid elements alike.
 *
 * A wrapper rather than encoding every JavaScript array: a `jsonb` column
 * handed a plain array stores a JSON array today, and an array literal sent
 * there would arrive as a malformed JSON string instead. Only the query can
 * say which one it means, since the query layer carries no column types.
 */
export class ArrayValue<T = unknown> {
  constructor(readonly values: readonly T[]) {}
}

export function isArrayValue(value: unknown): value is ArrayValue {
  return value instanceof ArrayValue
}

/**
 * The text of a Postgres array literal for `values`: `{"a","b c",NULL}`.
 *
 * Every element is double-quoted, with backslashes and double quotes escaped,
 * so a comma, a brace or a space inside one is only text. NULL is bare.
 * Numbers and booleans are quoted too, which Postgres reads the same as bare
 * when it casts the literal to the column's element type. A nested array is a
 * nested literal, a Date its ISO string, and any other object its JSON, which
 * is how a `jsonb[]` element is written.
 */
export function encodePgArray(values: readonly unknown[]): string {
  return `{${values.map(encodeElement).join(',')}}`
}

function encodeElement(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (Array.isArray(value)) return encodePgArray(value)
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
