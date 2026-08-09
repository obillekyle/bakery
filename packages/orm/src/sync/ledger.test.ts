import { describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { Field } from '../field'
import {
  LEDGER_TABLE,
  readLedger,
  resolveCurrentState,
  shapesMatch,
  stripLedger,
  writeLedger,
} from './ledger'

const SCHEMA: any = {
  led: { id: Field.Primary(), slug: Field.Varchar(255, '') },
}

describe('the schema ledger', () => {
  test('strips itself under every name a constraints object can use', () => {
    // `getConstraints()` camelCases table names, so the table created as
    // `__bakery_schema` comes back as `bakerySchema`. Matching only the literal
    // name stripped nothing, the ledger appeared in its own diff as an
    // undeclared table, the shape check failed forever, and the ledger was
    // therefore never used — silently, with every test still green.
    for (const alias of [LEDGER_TABLE, 'bakerySchema', '__bakery_schema']) {
      const stripped = stripLedger({ led: {}, [alias]: {} } as any)
      expect(Object.keys(stripped)).toEqual(['led'])
    }
  })

  test('shape comparison ignores metadata keys and column order', () => {
    expect(
      shapesMatch(
        { a: { y: {}, x: {} } } as any,
        { a: { x: {}, y: {} } } as any,
      ).ok,
    ).toBe(true)
    expect(
      shapesMatch({ a: { x: {}, _view: 'v' } } as any, { a: { x: {} } } as any)
        .ok,
    ).toBe(true)
  })

  test('shape comparison names what differs', () => {
    const gone = shapesMatch({ a: {}, b: {} } as any, { a: {} } as any)
    expect(gone.ok).toBe(false)
    if (!gone.ok) expect(gone.reason).toContain('b')

    const col = shapesMatch(
      { a: { x: {} } } as any,
      { a: { x: {}, y: {} } } as any,
    )
    expect(col.ok).toBe(false)
    if (!col.ok) expect(col.reason).toContain('a')
  })

  test('a database with no ledger reads back null, it does not throw', async () => {
    const db = new SQLiteAdapter(':memory:')
    expect(await readLedger(db as any)).toBeNull()
    await db.close()
  })

  test('round-trips the applied schema and prefers it once written', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db
      .query(
        `CREATE TABLE ${db.quote('led')} (${db.quote('id')} INTEGER PRIMARY KEY AUTOINCREMENT, ${db.quote('slug')} VARCHAR(255) NOT NULL DEFAULT '')`,
      )
      .run()

    const before = await resolveCurrentState(db)
    expect(before.source).toBe('introspection')

    expect(await writeLedger(db, SCHEMA)).toBe(true)
    const after = await resolveCurrentState(db)
    expect(after.source).toBe('ledger')
    // The point of the whole exercise: the width survives, which introspection
    // is not asked to report.
    expect((after.constraints as any).led.slug.length).toBe(255)
    await db.close()
  })

  test('drift falls back to introspection rather than migrating blind', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db
      .query(
        `CREATE TABLE ${db.quote('led')} (${db.quote('id')} INTEGER PRIMARY KEY AUTOINCREMENT, ${db.quote('slug')} TEXT NOT NULL)`,
      )
      .run()
    await writeLedger(db, SCHEMA)

    // Someone alters the database outside Bakery.
    await db
      .query(`ALTER TABLE ${db.quote('led')} ADD ${db.quote('rogue')} INTEGER`)
      .run()

    const state = await resolveCurrentState(db)
    expect(state.source).toBe('introspection')
    expect(state.reason).toContain('led')
    // …and the rogue column is visible, which is the safety property: trusting
    // the stale ledger here would plan a migration that never saw it.
    expect(Object.keys((state.constraints as any).led)).toContain('rogue')
    await db.close()
  })
})
