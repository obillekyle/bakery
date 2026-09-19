import { afterEach, describe, expect, test } from 'bun:test'
import { __resetTestDb, __setTestDb } from '@bakery-framework/orm/connection'
import { __resetIntrospectCache, introspect } from './identity'

/**
 * `introspect()` is 250 statements and 8.28 ms on a 50-table SQLite database,
 * and it runs on every write, every foreign-key hover and the graph endpoint.
 * It is cached against `schemaFingerprint()`, which is 10.4 us.
 *
 * These drive a stub adapter rather than a real database so the *number of
 * schema round trips* is observable. A timing assertion would be flaky and
 * would not actually say whether the walk happened.
 */
type Calls = { schema: number; constraints: number; indexes: number; fingerprint: number }

function stubAdapter(opts: { fingerprint?: () => string | null } = {}) {
  const calls: Calls = { schema: 0, constraints: 0, indexes: 0, fingerprint: 0 }
  const adapter: Record<string, unknown> = {
    driver: 'sqlite',
    getSchema: async (o?: { rowCounts?: boolean }) => {
      calls.schema++
      return [
        {
          name: 'users',
          rowCount: o?.rowCounts ? 7 : null,
          columns: [
            { name: 'id', type: 'INTEGER', pk: true },
            { name: 'name', type: 'TEXT', pk: false },
          ],
        },
      ]
    },
    getConstraints: async () => {
      calls.constraints++
      return { users: { id: { primary: true, autoIncrement: true } } }
    },
    getIndexes: async () => {
      calls.indexes++
      return {}
    },
  }
  if (opts.fingerprint) {
    adapter.schemaFingerprint = async () => {
      calls.fingerprint++
      return opts.fingerprint!()
    }
  }
  return { adapter, calls }
}

afterEach(() => {
  __resetTestDb()
  __resetIntrospectCache()
})

describe('introspection is cached against the schema fingerprint', () => {
  test('an unchanged schema is walked once, not once per call', async () => {
    const { adapter, calls } = stubAdapter({ fingerprint: () => 'sqlite::11' })
    __setTestDb(adapter)

    await introspect()
    await introspect()
    await introspect()

    expect(calls.schema).toBe(1)
    expect(calls.constraints).toBe(1)
    expect(calls.indexes).toBe(1)
    // The question is asked every time; only the answer is reused.
    expect(calls.fingerprint).toBe(3)
  })

  test('a changed fingerprint re-walks', async () => {
    let version = 11
    const { adapter, calls } = stubAdapter({
      fingerprint: () => `sqlite::${version}`,
    })
    __setTestDb(adapter)

    await introspect()
    await introspect()
    expect(calls.schema).toBe(1)

    // What a `DROP COLUMN` looks like from here. The entry describing the old
    // shape must not be handed to a write.
    version = 12
    await introspect()
    expect(calls.schema).toBe(2)
  })

  test('row counts are never served from the cache', async () => {
    // `schema_version` does not move for an `INSERT`, which is what makes it
    // a good key for schema and a wrong one for `COUNT(*)`. A cached count
    // would stay wrong until somebody changed the schema.
    const { adapter, calls } = stubAdapter({ fingerprint: () => 'sqlite::11' })
    __setTestDb(adapter)

    await introspect({ rowCounts: true })
    await introspect({ rowCounts: true })
    expect(calls.schema).toBe(2)
    expect(calls.fingerprint).toBe(0)
  })

  test('a counted walk does not poison the plain one', async () => {
    const { adapter, calls } = stubAdapter({ fingerprint: () => 'sqlite::11' })
    __setTestDb(adapter)

    await introspect({ rowCounts: true })
    const plain = await introspect()
    // The counted result was not stored, so the plain call had to walk.
    expect(calls.schema).toBe(2)
    expect(plain.get('users')?.rowCount ?? null).toBe(null)
  })

  test('an adapter that cannot answer is never cached', async () => {
    // Postgres and MySQL today, and any third-party adapter written against a
    // base class that predates the method.
    const { adapter, calls } = stubAdapter({ fingerprint: () => null })
    __setTestDb(adapter)

    await introspect()
    await introspect()
    expect(calls.schema).toBe(2)
  })

  test('an adapter with no such method at all still works', async () => {
    // Not a hypothetical: every stub in this package's own suite is this
    // shape, and calling the method unconditionally turned a missing
    // optimisation into a failed request.
    const { adapter, calls } = stubAdapter()
    __setTestDb(adapter)

    await expect(introspect()).resolves.toBeDefined()
    await introspect()
    expect(calls.schema).toBe(2)
  })

  test('two databases at the same version do not share an entry', async () => {
    // The adapter prefixes the counter with the driver and the file for this
    // reason: a fresh database starts near zero, so a small integer is a value
    // many of them hold at once.
    let file = '/one.db'
    const { adapter, calls } = stubAdapter({ fingerprint: () => `sqlite:${file}:3` })
    __setTestDb(adapter)

    await introspect()
    expect(calls.schema).toBe(1)

    file = '/two.db'
    await introspect()
    expect(calls.schema).toBe(2)
  })
})
