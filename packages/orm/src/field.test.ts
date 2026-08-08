import { describe, expect, test } from 'bun:test'
import { Field } from './field'

/**
 * The exact objects each builder emits.
 *
 * These used to be written as "`Field` is `value()` with names", comparing each
 * builder against the primitive it wrapped. `Field` now *is* the primitive —
 * `value`/`primary`/`index`/`unique`/`foreign` are gone — so there is nothing
 * left to compare against and the assertions are the literal shapes instead.
 * That is the stronger form anyway: the sync engine and the type inference
 * consume these objects directly, so their exact keys are the contract.
 */
describe('Field emits plain column descriptors', () => {
  test('each builder emits the shape its name promises', () => {
    expect({ ...Field.Int() }).toEqual({ type: 'integer' })
    expect({ ...Field.Int(0) }).toEqual({ type: 'integer', default: 0 } as any)
    expect({ ...Field.Float(1.5) }).toEqual({
      type: 'number',
      default: 1.5,
    } as any)
    expect({ ...Field.String('x') }).toEqual({
      type: 'string',
      default: 'x',
    } as any)
    expect({ ...Field.Bool(true) }).toEqual({
      type: 'boolean',
      default: true,
    } as any)
    expect({ ...Field.Blob() }).toEqual({
      type: 'buffer',
      default: null,
      nullable: true,
    } as any)
    // `Date` is an integer column; `Date.now()` is the same column with the
    // marker default each adapter renders in its own dialect.
    expect({ ...Field.Date(0) }).toEqual({ ...Field.Int(0) })
    expect({ ...Field.Date.now() }).toEqual({
      type: 'integer',
      default: '%dateNow%',
    } as any)
    // `String()` and `Text()` are the same unbounded column; the names differ
    // only in what they tell the reader about intent.
    expect({ ...Field.String() }).toEqual({ ...Field.Text() })
  })

  test('null means nullable', () => {
    // Cast on the *expectation*, not the builder: `TableDef` omits `default`
    // from its type when the default is null (the column is nullable instead),
    // so the literal is wider than the computed type even though the runtime
    // objects match — which is exactly what this asserts.
    expect({ ...Field.String(null) }).toEqual({
      type: 'string',
      default: null,
      nullable: true,
    } as any)
    // …and no argument is NOT the same as null: NOT NULL, no default.
    expect({ ...Field.String() }).toEqual({ type: 'string' })
  })

  test('a constraint carries only data, never builder machinery', () => {
    // The sync engine enumerates these objects. A method or a hidden field
    // reaching the plan would diff against the database forever.
    for (const def of [Field.Primary(), Field.String(null), Field.Date.now()]) {
      for (const [k, v] of Object.entries(def)) {
        expect(typeof v).not.toBe('function')
        expect(['type', 'default', 'nullable', 'autoIncrement', 'primary']).toContain(k)
      }
    }
  })

  test('Varchar carries its width, Text deliberately takes no default', () => {
    // The width is what lets a text column hold a default at all on MySQL,
    // which rejects one on TEXT.
    expect({ ...Field.Varchar(255, '') }).toEqual({
      type: 'string',
      default: '',
      length: 255,
    } as any)
    expect({ ...Field.Text() }).toEqual({ type: 'string' })
    expect({ ...Field.Text(true) }).toEqual({
      type: 'string',
      default: null,
      nullable: true,
    } as any)
  })

  test('BigInt and Json are their own types, not aliases of string', () => {
    // If either collapsed back into an existing type, the adapters would emit
    // one column type and read another back — a rebuild on every sync.
    expect({ ...Field.BigInt() }).toEqual({ type: 'bigint' } as any)
    expect({ ...Field.Json() }).toEqual({ type: 'json' } as any)
    expect({ ...Field.Json(true) }).toEqual({
      type: 'json',
      default: null,
      nullable: true,
    } as any)
  })

  test('Primary is the id column, spelled correctly', () => {
    expect({ ...Field.Primary() }).toEqual({
      type: 'integer',
      autoIncrement: true,
      primary: true,
    })
  })
})
