import { describe, expect, test } from 'bun:test'
import { SQLiteAdapter } from '../adapters/sqlite'
import { Field } from '../field'
import { diffEntries, formatEntry, formatWhen, isEmptyDiff } from './history'
import {
  LEDGER_TABLE,
  detectDrift,
  readLedgerEntries,
  writeLedger,
} from './ledger'
import { pickTarget } from './rollback'

const V1: any = { led: { id: Field.Primary(), slug: Field.Varchar(255, '') } }
const V2: any = {
  led: { id: Field.Primary(), slug: Field.Varchar(255, ''), title: Field.Text() },
  extra: { id: Field.Primary() },
}

/** A ledger row as `writeLedger` wrote them before the payload carried indexes. */
async function writeV1Row(db: any, constraints: any) {
  const q = (s: string) => db.quote(s)
  const id = db.colDef({ type: 'integer', autoIncrement: true, primary: true })
  const at = db.colDef({ type: 'integer' })
  const payload = db.colDef({ type: 'string' })
  await db
    .query(
      `CREATE TABLE IF NOT EXISTS ${q(LEDGER_TABLE)} (` +
        `${q('id')} ${id}, ${q('applied_at')} ${at}, ${q('payload')} ${payload})`,
    )
    .run()
  await db
    .query(
      `INSERT INTO ${q(LEDGER_TABLE)} (${q('applied_at')}, ${q('payload')}) VALUES (?, ?)`,
    )
    .run(1_700_000_000, JSON.stringify(constraints))
}

describe('ledger payload v2', () => {
  test('records the indexes applied alongside the constraints', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    const indexes = { ledSlug: { table: 'led', columns: ['slug'], type: 'unique' } }
    expect(await writeLedger(db, V1, indexes as any)).toBe(true)

    const [entry] = await readLedgerEntries(db)
    expect(entry?.constraints).toHaveProperty('led')
    // The reason v2 exists: replaying an entry with no index record would read
    // as "drop every index".
    expect(entry?.indexes).toEqual(indexes as any)
    await db.close()
  })

  test('still reads rows written before the payload had a version', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await writeV1Row(db, V1)

    const [entry] = await readLedgerEntries(db)
    expect(entry?.constraints).toHaveProperty('led')
    // Distinct from `{}` on purpose — "not recorded" is what `db:rollback`
    // branches on, and an empty object would claim there were no indexes.
    expect(entry?.indexes).toBeUndefined()
    await db.close()
  })

  test('a row that will not parse is skipped, not surfaced as an entry', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await writeLedger(db, V1, {})
    const q = (s: string) => db.quote(s)
    await db
      .query(
        `INSERT INTO ${q(LEDGER_TABLE)} (${q('applied_at')}, ${q('payload')}) VALUES (?, ?)`,
      )
      .run(1_700_000_001, 'not json{')

    const entries = await readLedgerEntries(db)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.constraints).toHaveProperty('led')
    await db.close()
  })

  test('entries come back newest first', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await writeLedger(db, V1, {})
    await writeLedger(db, V2, {})

    const entries = await readLedgerEntries(db)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.id).toBeGreaterThan(entries[1]!.id)
    // Newest carries the newer schema.
    expect(Object.keys(entries[0]!.constraints)).toContain('extra')
    await db.close()
  })
})

describe('history diffing', () => {
  test('names the tables and columns that came and went', () => {
    const d = diffEntries(V1, V2)
    expect(d.tablesAdded).toEqual(['extra'])
    expect(d.tablesRemoved).toEqual([])
    expect(d.columnsAdded).toEqual(['led.title'])
    expect(d.columnsRemoved).toEqual([])
  })

  test('does not re-list the columns of a table it already reported as added', () => {
    // `extra` is new, so its `id` is already covered by `tablesAdded`. Listing
    // both makes a one-table migration read as several changes.
    const d = diffEntries(V1, V2)
    expect(d.columnsAdded).not.toContain('extra.id')
  })

  test('reports the reverse direction as removals', () => {
    const d = diffEntries(V2, V1)
    expect(d.tablesRemoved).toEqual(['extra'])
    expect(d.columnsRemoved).toEqual(['led.title'])
    expect(d.tablesAdded).toEqual([])
  })

  test('an unchanged pair is an empty diff', () => {
    expect(isEmptyDiff(diffEntries(V1, V1))).toBe(true)
    expect(isEmptyDiff(diffEntries(V1, V2))).toBe(false)
  })

  test('timestamps render as UTC, and a missing one says so', () => {
    expect(formatWhen(1_700_000_000)).toBe('2023-11-14 22:13:20')
    expect(formatWhen(0)).toBe('unknown')
    expect(formatWhen(Number.NaN)).toBe('unknown')
  })

  test('the oldest entry is labelled initial rather than diffed against nothing', () => {
    const entry = { id: 1, appliedAt: 1_700_000_000, constraints: V1, indexes: {} }
    const lines = formatEntry(entry, undefined, false).join('\n')
    expect(lines).toContain('initial schema')
  })

  test('an entry with no index record says so, because rollback treats it differently', () => {
    const entry = { id: 2, appliedAt: 1_700_000_000, constraints: V1 }
    const lines = formatEntry(entry, undefined, true).join('\n')
    expect(lines).toContain('ledger v2')
    expect(lines).toContain('(current)')
  })
})

describe('rollback target selection', () => {
  const entry = (id: number): any => ({ id, appliedAt: id, constraints: V1 })

  test('with no --to, picks one step back', () => {
    const picked = pickTarget([entry(3), entry(2), entry(1)])
    expect(picked.ok).toBe(true)
    if (picked.ok) {
      expect(picked.target.id).toBe(2)
      expect(picked.steps).toBe(1)
    }
  })

  test('refuses when there is no history at all', () => {
    const picked = pickTarget([])
    expect(picked.ok).toBe(false)
    if (!picked.ok) expect(picked.code).toBe('NO_HISTORY')
  })

  test('refuses when only one schema was ever applied', () => {
    // There is a current state but nothing before it, which is a different
    // message from "no history" — the user has synced, just only once.
    const picked = pickTarget([entry(1)])
    expect(picked.ok).toBe(false)
    if (!picked.ok) expect(picked.code).toBe('ONLY_ONE')
  })

  test('--to names an entry, and reports how far back it is', () => {
    const picked = pickTarget([entry(5), entry(4), entry(3)], 3)
    expect(picked.ok).toBe(true)
    if (picked.ok) expect(picked.steps).toBe(2)
  })

  test('refuses --to for the current schema, and for one that is not there', () => {
    const current = pickTarget([entry(5), entry(4)], 5)
    expect(current.ok).toBe(false)
    if (!current.ok) expect(current.code).toBe('IS_CURRENT')

    const missing = pickTarget([entry(5), entry(4)], 99)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('NO_SUCH_ENTRY')
  })
})

describe('drift detection', () => {
  test('a database with no ledger has not drifted', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    // Not "no drift because everything matches" — there is simply nothing to
    // compare against, and reporting drift here would fire on every new project.
    expect(await detectDrift(db)).toBeNull()
    await db.close()
  })

  test('an untouched database reports no drift', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db.query('CREATE TABLE led (id INTEGER PRIMARY KEY, slug TEXT)').run()
    await writeLedger(db, await db.getConstraints(), {})
    expect(await detectDrift(db)).toBeNull()
    await db.close()
  })

  test('a column added outside Bakery is reported, and names the table', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db.query('CREATE TABLE led (id INTEGER PRIMARY KEY, slug TEXT)').run()
    await writeLedger(db, await db.getConstraints(), {})

    // The scenario the warning exists for: someone ran an ALTER by hand.
    await db.query('ALTER TABLE led ADD COLUMN sneaky TEXT').run()

    const drift = await detectDrift(db)
    expect(drift).not.toBeNull()
    expect(drift?.reason).toContain('led')
    await db.close()
  })

  test('a table added outside Bakery is reported', async () => {
    const db = new SQLiteAdapter(':memory:') as any
    await db.query('CREATE TABLE led (id INTEGER PRIMARY KEY)').run()
    await writeLedger(db, await db.getConstraints(), {})
    await db.query('CREATE TABLE rogue (id INTEGER PRIMARY KEY)').run()

    const drift = await detectDrift(db)
    expect(drift?.reason).toContain('rogue')
    await db.close()
  })
})
