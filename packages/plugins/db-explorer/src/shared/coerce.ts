/**
 * Wire value → column value, and the validation that goes with it.
 *
 * **Pure.** No `Bun.*`, no node builtins, no DOM — convention 5's rule applied
 * inside the plugin, because this module is imported by the endpoints *and*
 * compiled into the browser bundle, so the grid can tell a user their input is
 * wrong before a request is made and get the same answer the server would give.
 * One implementation is the only way those two answers stay equal.
 *
 * **Pure also means importing nothing from `@bakery-framework/*`, including
 * `utils/isomorphic`.** That reads like the one safe exception — it is the
 * framework's own pure layer — and it is not, for a mechanical reason:
 * `bundleModule` marks every *installed package* external
 * (`compiler.ts:316`), so a framework import survives into the emitted bundle
 * as a bare specifier, the browser tries to fetch
 * `@bakery-framework/core/utils/isomorphic` as a URL, and the whole module
 * fails to load. Chrome reports that as "Failed to fetch dynamically imported
 * module", naming `app.js` rather than the import that actually broke.
 *
 * A `Try` import cost exactly that, and the dashboard's client avoids every
 * `@bakery-framework/*` import for the same reason without saying so anywhere.
 *
 * So: duplicate the three lines. The alternative is a page that does not boot.
 *
 * **The three wire states the dashboard collapsed into one.** Its editor read
 * every cell as a string and let the driver sort it out, so there was no way to
 * express "leave this alone", an empty text field cleared to `NULL`, and `""`
 * into a numeric column silently became `0`. Here:
 *
 *   - **key absent** — leave the column unchanged. Never reaches this function.
 *   - **`null`** — SQL NULL. Refused on a NOT NULL column rather than coerced.
 *   - **`""`** — the empty string. On a text column that is a value; on any
 *     other kind it is an error, never zero and never NULL.
 *
 * And `"007"` is a string in a text column and the number 7 in an integer one,
 * which is the same rule stated once: the *column* decides, not the shape of
 * the characters.
 */

/**
 * What kind of value a column holds.
 *
 * The ORM's own `ColumnType` plus `date`. That extra member is not reachable
 * from `getConstraints()` — the ORM stores timestamps as integer seconds, so it
 * reports `integer` — and exists for a column some other tool created as a real
 * `DATE`/`TIMESTAMP`, which the raw SQL type from `getSchema()` reveals. A
 * genuine date column binds a `Date`, and an integer timestamp binds a number;
 * conflating them is how a timestamp ends up written as the year 1970.
 */
export type ColumnKind =
  | 'integer'
  | 'number'
  | 'bigint'
  | 'string'
  | 'boolean'
  | 'json'
  | 'buffer'
  | 'date'

export interface ColumnMeta {
  kind: ColumnKind
  /** Whether SQL NULL is permitted. */
  nullable: boolean
  /** Character length of a sized text column, if it declares one. */
  length?: number
  /** Permitted values, for `Field.Enum`. */
  enum?: readonly string[]
  /** Whether the database supplies a value when the column is omitted. */
  hasDefault: boolean
  primary?: boolean
  autoIncrement?: boolean
}

export type CoerceCode =
  | 'not_null'
  | 'empty_string'
  | 'type'
  | 'too_long'
  | 'not_in_enum'
  | 'not_integer'
  | 'not_finite'
  | 'bad_json'
  | 'bad_date'
  | 'bad_base64'
  | 'bad_boolean'

export type CoerceResult =
  | { ok: true; value: unknown }
  | { ok: false; code: CoerceCode; message: string }

const fail = (code: CoerceCode, message: string): CoerceResult => ({
  ok: false,
  code,
  message,
})

const ok = (value: unknown): CoerceResult => ({ ok: true, value })

/**
 * Kinds whose values can be compared as an equality predicate in SQL.
 *
 * `json` and `buffer` cannot, portably: MySQL compares JSON structurally,
 * Postgres refuses `=` on `json` outright (only `jsonb` has it), and a blob
 * comparison depends on how the driver bound the parameter. An optimistic
 * `expect` on one of these would be a predicate that silently never matched —
 * every edit a 409 — so it is refused instead.
 */
export function comparableKind(kind: ColumnKind): boolean {
  return kind !== 'json' && kind !== 'buffer'
}

const RX_INTEGER = /^[+-]?\d+$/

function coerceInteger(raw: unknown, meta: ColumnMeta): CoerceResult {
  let n: number | bigint
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail('not_finite', 'not a finite number')
    if (!Number.isInteger(raw)) return fail('not_integer', 'not a whole number')
    n = raw
  } else if (typeof raw === 'bigint') {
    n = raw
  } else if (typeof raw === 'string') {
    const t = raw.trim()
    if (!RX_INTEGER.test(t)) return fail('not_integer', 'not a whole number')
    // Through BigInt first, then narrowed: `Number('9007199254740993')` is a
    // different integer from the one that was typed, and it rounds silently.
    n = BigInt(t)
  } else {
    return fail('type', `expected a whole number, got ${typeName(raw)}`)
  }

  if (typeof n === 'bigint') {
    // Narrowed back to a number when it fits, so the common case binds the
    // type every driver has always taken. A value outside the safe range stays
    // a bigint, because turning it into a `number` is the precision loss this
    // branch exists to avoid — `bigint` is the ORM's own column kind for it.
    const inSafeRange =
      n <= BigInt(Number.MAX_SAFE_INTEGER) &&
      n >= BigInt(Number.MIN_SAFE_INTEGER)
    if (inSafeRange) return ok(Number(n))
    if (meta.kind !== 'bigint') {
      return fail('not_integer', 'outside the range of an integer column')
    }
    return ok(n)
  }
  return ok(n)
}

function coerceNumber(raw: unknown): CoerceResult {
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? ok(raw)
      : fail('not_finite', 'not a finite number')
  }
  if (typeof raw === 'bigint') return ok(Number(raw))
  if (typeof raw === 'string') {
    const t = raw.trim()
    const n = Number(t)
    // `Number('')` is 0 and `Number(' ')` is 0. The empty case is already
    // refused above; this guards the whitespace-only spelling of it.
    if (t === '' || !Number.isFinite(n))
      return fail('not_finite', 'not a number')
    return ok(n)
  }
  return fail('type', `expected a number, got ${typeName(raw)}`)
}

const TRUEISH = new Set(['true', 't', 'yes', 'y', '1'])
const FALSEISH = new Set(['false', 'f', 'no', 'n', '0'])

function coerceBoolean(raw: unknown): CoerceResult {
  if (typeof raw === 'boolean') return ok(raw)
  if (typeof raw === 'number') {
    if (raw === 1) return ok(true)
    if (raw === 0) return ok(false)
    return fail('bad_boolean', 'expected true/false, 1 or 0')
  }
  if (typeof raw === 'string') {
    const t = raw.trim().toLowerCase()
    if (TRUEISH.has(t)) return ok(true)
    if (FALSEISH.has(t)) return ok(false)
    return fail('bad_boolean', `not a boolean: ${JSON.stringify(raw)}`)
  }
  return fail('type', `expected a boolean, got ${typeName(raw)}`)
}

/**
 * A real date/time column, bound as a `Date`.
 *
 * Accepts an ISO-8601 string or a number of **milliseconds** since the epoch —
 * milliseconds because that is what `Date.now()` and `JSON.stringify(new Date)`
 * produce on the client, and a value that is ambiguous between the two units
 * does not exist: an integer timestamp column reports kind `integer` and never
 * arrives here.
 */
function coerceDate(raw: unknown): CoerceResult {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime())
      ? fail('bad_date', 'invalid date')
      : ok(raw)
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return fail('bad_date', 'invalid date')
    return ok(new Date(raw))
  }
  if (typeof raw === 'string') {
    const ms = Date.parse(raw.trim())
    if (Number.isNaN(ms))
      return fail('bad_date', `not a date: ${JSON.stringify(raw)}`)
    return ok(new Date(ms))
  }
  return fail('type', `expected a date, got ${typeName(raw)}`)
}

/**
 * A JSON column, stored as text.
 *
 * The ORM serialises nothing — `Field.Json` declares the column type and the
 * application decides what goes in it — so the explorer stores text and refuses
 * text that is not JSON. An object or array on the wire is serialised here
 * rather than at the call site, so the grid can send either spelling.
 */
function coerceJson(raw: unknown): CoerceResult {
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw)
    } catch {
      // Not silent: the caller gets the failure as a field error. The parse is
      // only being used as a validity test, so the thrown message adds nothing
      // the code does not already say.
      return fail('bad_json', 'not valid JSON')
    }
    return ok(raw)
  }
  if (typeof raw === 'object' || Array.isArray(raw)) {
    try {
      return ok(JSON.stringify(raw))
    } catch {
      // A cycle, or a BigInt. Same reasoning as above.
      return fail('bad_json', 'value cannot be serialised as JSON')
    }
  }
  return fail('type', `expected JSON, got ${typeName(raw)}`)
}

const RX_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * A binary column, carried as base64.
 *
 * `atob` rather than `Buffer` or `Bun.from`: this module is compiled into the
 * browser bundle, and `atob` is the one decoder both runtimes have.
 */
function coerceBuffer(raw: unknown): CoerceResult {
  if (raw instanceof Uint8Array) return ok(raw)
  if (typeof raw !== 'string') {
    return fail('type', `expected base64 text, got ${typeName(raw)}`)
  }
  const t = raw.trim()
  if (t.length % 4 !== 0 || !RX_BASE64.test(t)) {
    return fail('bad_base64', 'not base64')
  }
  try {
    const binary = atob(t)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return ok(bytes)
  } catch {
    // `atob` throws on padding it cannot place, which the regex above does not
    // catch. The caller gets it as a field error, so there is nothing to log.
    return fail('bad_base64', 'not base64')
  }
}

function coerceString(raw: unknown, meta: ColumnMeta): CoerceResult {
  if (typeof raw !== 'string') {
    // Deliberately strict, and this is the `"007"` rule from the other side: a
    // number arriving for a text column has already lost its leading zeros, so
    // accepting it would silently store a different value than was typed.
    return fail('type', `expected text, got ${typeName(raw)}`)
  }
  if (meta.enum && !meta.enum.includes(raw)) {
    return fail('not_in_enum', `not one of: ${meta.enum.join(', ')}`)
  }
  if (meta.length !== undefined && raw.length > meta.length) {
    return fail('too_long', `longer than ${meta.length} characters`)
  }
  return ok(raw)
}

function typeName(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/**
 * One wire value, for one column.
 *
 * `undefined` never arrives: an absent key means "leave unchanged" and is
 * resolved by the caller, which is the only place that knows whether it is
 * building an INSERT (where absent means "use the default") or an UPDATE
 * (where it means "do not touch this column").
 */
export function coerceValue(raw: unknown, meta: ColumnMeta): CoerceResult {
  if (raw === null) {
    return meta.nullable
      ? ok(null)
      : fail('not_null', 'this column cannot be null')
  }

  if (raw === '' && meta.kind !== 'string') {
    // The whole reason this function returns a result rather than a value.
    // `Number('')` is 0, `Boolean('')` is false and `new Date('')` is Invalid
    // Date — three different wrong answers for the same input, which is what
    // the dashboard's editor shipped.
    return fail(
      'empty_string',
      `an empty string is not a value for a ${meta.kind} column; send null for SQL NULL`,
    )
  }

  switch (meta.kind) {
    case 'string':
      return coerceString(raw, meta)
    case 'integer':
    case 'bigint':
      return coerceInteger(raw, meta)
    case 'number':
      return coerceNumber(raw)
    case 'boolean':
      return coerceBoolean(raw)
    case 'date':
      return coerceDate(raw)
    case 'json':
      return coerceJson(raw)
    case 'buffer':
      return coerceBuffer(raw)
  }
}

/**
 * Whether a column may be left out of an INSERT.
 *
 * An auto-increment key is supplied by the database, a column with a default is
 * supplied by the database, and a nullable column defaults to NULL. Anything
 * else has to be given a value.
 */
export function omittableOnInsert(meta: ColumnMeta): boolean {
  return Boolean(meta.autoIncrement) || meta.hasDefault || meta.nullable
}

/**
 * "Did the user actually change this?" — deliberately loose.
 *
 * The two operands come from different worlds: the left is a value the database
 * returned, the right is whatever JSON the browser sent, and a driver that
 * hands back `1` for a boolean or a string for a `BIGINT` is not a difference
 * the user made. Strict equality here would send a `set` full of columns nobody
 * touched, which is how an optimistic-concurrency check turns into a conflict
 * for every concurrent editor of any column.
 *
 * This is used to *shrink* a statement, never to decide correctness — the
 * server's own conflict check is a SQL predicate, not this.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : Date.parse(String(a))
    const bt = b instanceof Date ? b.getTime() : Date.parse(String(b))
    return at === bt
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    // SQLite hands a boolean column back as `1`/`0` and MySQL as `1`/`0` on a
    // `TINYINT(1)`, while the browser sends `true`/`false`. Comparing those as
    // strings makes every boolean look edited.
    return asBoolish(a) === asBoolish(b)
  }
  if (typeof a === 'object' || typeof b === 'object') {
    // A cyclic object throws in `JSON.stringify`, and "could not be compared"
    // has to mean "not equal" — the conservative direction, because it keeps
    // the column in the statement rather than dropping an edit the user made.
    //
    // A bare try/catch rather than core's `Try`, and that is a constraint of
    // this directory rather than a preference: see the module header.
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch {
      return false
    }
  }
  return String(a) === String(b)
}

function asBoolish(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  return TRUEISH.has(String(value).trim().toLowerCase())
}
