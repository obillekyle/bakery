import { describe, expect, test } from 'bun:test'
import { Field } from './field'
import { primary, value } from './schema-util'

/**
 * `Field` must stay a pure renaming of `value()`.
 *
 * The whole safety argument for it is that the sync engine and the type
 * inference never learn it exists — they keep seeing the objects `value()`
 * builds. These assertions are what makes that true rather than intended: if a
 * builder ever grows its own shape, the constraint it emits stops matching and
 * this fails.
 */
describe('Field is value() with names', () => {
  test('each builder emits exactly what value() emits', () => {
    expect({ ...Field.Primary() }).toEqual({ ...primary() })
    expect({ ...Field.Int() }).toEqual({ ...value('integer') })
    expect({ ...Field.Int(0) }).toEqual({ ...value('integer', 0) })
    expect({ ...Field.Float(1.5) }).toEqual({ ...value('number', 1.5) })
    expect({ ...Field.String() }).toEqual({ ...value('string') })
    expect({ ...Field.String('x') }).toEqual({ ...value('string', 'x') })
    expect({ ...Field.Bool(true) }).toEqual({ ...value('boolean', true) })
    expect({ ...Field.Blob() }).toEqual({ ...value('buffer', null) })
    expect({ ...Field.Date(0) }).toEqual({ ...value('integer', 0) })
    expect({ ...Field.Date.now() }).toEqual({ ...value('integer', '%dateNow%') })
  })

  test('null means nullable, matching value()', () => {
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

  test('Primary is the id column, spelled correctly', () => {
    expect({ ...Field.Primary() }).toEqual({
      type: 'integer',
      autoIncrement: true,
      primary: true,
    })
  })
})
