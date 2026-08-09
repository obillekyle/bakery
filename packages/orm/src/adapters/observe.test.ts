import { afterEach, describe, expect, test } from 'bun:test'
import { createExecutor, type SQLAdapter } from './base'
import { getQueryObserver, type QueryEvent, setQueryObserver } from './observe'

/**
 * The observer is process-wide state, so every test here restores it — a leaked
 * observer would otherwise collect events from every ORM test file Bun loads
 * afterwards and, worse, a leaked *throwing* one would fail them.
 */
afterEach(() => {
  setQueryObserver(null)
})

const ROWS: SQLAdapter.RowRecord[] = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
]

interface Stub {
  exec: SQLAdapter.Executor
  calls: { method: string; sql: string; params: unknown[] }[]
}

function stubExecutor(
  driver: SQLAdapter.Driver = 'sqlite',
  opts: { delayMs?: number; throwOn?: string } = {},
): Stub {
  const calls: Stub['calls'] = []
  const guard = async (method: string, sql: string, params: unknown[]) => {
    calls.push({ method, sql, params })
    if (opts.delayMs) await Bun.sleep(opts.delayMs)
    if (opts.throwOn && sql.includes(opts.throwOn))
      throw new Error('stub query failed')
  }

  const exec = createExecutor(
    async (sql: string, params: unknown[] = []) => {
      await guard('all', sql, params)
      return ROWS
    },
    async (sql: string, params: unknown[] = []) => {
      await guard('run', sql, params)
      return { lastInsertRowid: 7, changes: 3 }
    },
    driver,
    {
      // An explicit walker, because these tests are about the *observer*, not
      // about how rows are fetched — `pagedIterate` would issue its own
      // windowed statements and the assertions below count calls.
      iterate: async function* (sql: string, params: unknown[] = []) {
        await guard('iterate', sql, params)
        for (const row of ROWS) {
          if (opts.delayMs) await Bun.sleep(opts.delayMs)
          yield row
        }
      },
    },
  )
  return { exec, calls }
}

describe('setQueryObserver', () => {
  test('is not called when unset', async () => {
    const { exec, calls } = stubExecutor()

    await exec.all('SELECT 1')
    await exec.run('INSERT INTO t VALUES (1)')
    await exec.get('SELECT 1')
    await exec.values('SELECT 1')
    for await (const _row of exec.iterate('SELECT 1')) {
      // drained for the side effect
    }

    expect(getQueryObserver()).toBeNull()
    // The queries still ran — an unset observer must not short-circuit anything.
    expect(calls.length).toBe(5)
  })

  test('the unobserved path returns the driver value untouched', async () => {
    // The whole "free when unset" claim rests on this: no wrapping, no
    // re-boxing, no generator standing between caller and driver.
    const { exec } = stubExecutor()
    expect(await exec.all('SELECT 1')).toBe(ROWS)
  })

  test('the disposer only removes the observer it installed', () => {
    const first = () => {}
    const second = () => {}
    const offFirst = setQueryObserver(first)
    const offSecond = setQueryObserver(second)

    offFirst()
    expect(getQueryObserver()).toBe(second)

    offSecond()
    expect(getQueryObserver()).toBeNull()
  })
})

describe('query events', () => {
  test('fires once per statement with a plausible duration', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor('postgres', { delayMs: 20 })

    await exec.all('SELECT * FROM t')

    expect(events.length).toBe(1)
    expect(events[0].sql).toBe('SELECT * FROM t')
    expect(events[0].driver).toBe('postgres')
    expect(events[0].method).toBe('all')
    expect(events[0].rows).toBe(2)
    expect(events[0].error).toBeNull()
    // Real wall clock, not a placeholder: the stub sleeps 20ms. The upper bound
    // is loose on purpose — a tight one turns a busy CI box into a flake.
    expect(events[0].ms).toBeGreaterThanOrEqual(15)
    expect(events[0].ms).toBeLessThan(5000)
  })

  test('every execution path reports, and exactly once', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor()

    await exec.all('SELECT a')
    await exec.run('INSERT b')
    await exec.get('SELECT c')
    await exec.values('SELECT d')
    for await (const _row of exec.iterate('SELECT e')) {
      // drained for the side effect
    }

    // Five statements, five events. `get` and `values` are built on `all`, so
    // the count is the regression guard against double-reporting them.
    expect(events.map(e => e.method)).toEqual([
      'all',
      'run',
      'get',
      'values',
      'iterate',
    ])
    expect(events.map(e => e.sql)).toEqual([
      'SELECT a',
      'INSERT b',
      'SELECT c',
      'SELECT d',
      'SELECT e',
    ])
  })

  test('rows means the right thing per method', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor()

    await exec.all('SELECT a')
    await exec.run('INSERT b')
    await exec.get('SELECT c')
    await exec.values('SELECT d')

    expect(events[0].rows).toBe(2) // rows returned
    expect(events[1].rows).toBe(3) // rows *affected*, from RunResult.changes
    expect(events[2].rows).toBe(1) // get found one
    expect(events[3].rows).toBe(2)
  })

  test('get reports 0 rows when nothing matched', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const exec = createExecutor(
      async () => [],
      async () => ({ lastInsertRowid: null, changes: 0 }),
      'mysql',
      { iterate: async function* () {} },
    )

    expect(await exec.get('SELECT nothing')).toBeUndefined()
    expect(events[0].rows).toBe(0)
    expect(events[0].driver).toBe('mysql')
  })

  test('the driver is whatever the adapter declared', async () => {
    for (const driver of ['sqlite', 'postgres', 'mysql'] as const) {
      const events: QueryEvent[] = []
      const off = setQueryObserver(e => events.push(e))
      const { exec } = stubExecutor(driver)
      await exec.all('SELECT 1')
      off()
      expect(events[0].driver).toBe(driver)
    }
  })
})

describe('errors', () => {
  test('a failed query still reports, and still throws', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor('sqlite', { throwOn: 'BROKEN' })

    await expect(exec.all('SELECT BROKEN')).rejects.toThrow('stub query failed')
    await Bun.sleep(5)

    expect(events.length).toBe(1)
    expect((events[0].error as Error).message).toBe('stub query failed')
    // Unknowable for a statement that never produced a result set.
    expect(events[0].rows).toBeNull()
    expect(events[0].sql).toBe('SELECT BROKEN')
  })

  test('a throwing observer does not break the query', async () => {
    setQueryObserver(() => {
      throw new Error('observer exploded')
    })
    const { exec } = stubExecutor()

    expect(await exec.all('SELECT 1')).toEqual(ROWS)
    expect(await exec.run('INSERT 1')).toEqual({
      lastInsertRowid: 7,
      changes: 3,
    })
    expect(await exec.get('SELECT 1')).toEqual(ROWS[0])

    const streamed: unknown[] = []
    for await (const row of exec.iterate('SELECT 1')) streamed.push(row)
    expect(streamed).toEqual(ROWS)
  })

  test('a rejecting async observer does not break the query', async () => {
    // A hook doing `await fetch(...)` is the realistic shape, and an unhandled
    // rejection out of the ORM's hot path would be someone else's crash.
    setQueryObserver(async () => {
      throw new Error('observer rejected')
    })
    const { exec } = stubExecutor()
    expect(await exec.all('SELECT 1')).toEqual(ROWS)
    await Bun.sleep(5)
  })

  test('an observer throwing on a failed query leaves the original error', async () => {
    setQueryObserver(() => {
      throw new Error('observer exploded')
    })
    const { exec } = stubExecutor('sqlite', { throwOn: 'BROKEN' })
    await expect(exec.all('SELECT BROKEN')).rejects.toThrow('stub query failed')
    await Bun.sleep(5)
  })
})

describe('parameters are not exposed by default', () => {
  test('no params key at all unless asked for', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor()

    await exec.all('SELECT * FROM users WHERE token = ?', ['s3cret-token'])
    await exec.run('INSERT INTO users VALUES (?)', ['hunter2'])
    await exec.get('SELECT 1', ['pii@example.com'])
    await exec.values('SELECT 1', ['pii@example.com'])
    for await (const _row of exec.iterate('SELECT 1', ['pii@example.com'])) {
      // drained for the side effect
    }

    for (const event of events) {
      expect('params' in event).toBe(false)
      expect(event.params).toBeUndefined()
    }
    // Belt and braces: nothing leaks the value through another field either.
    expect(JSON.stringify(events)).not.toContain('s3cret-token')
    expect(JSON.stringify(events)).not.toContain('hunter2')
    expect(JSON.stringify(events)).not.toContain('pii@example.com')
  })

  test('an explicit false is still off', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e), { params: false })
    const { exec } = stubExecutor()
    await exec.all('SELECT ?', ['secret'])
    expect(events[0].params).toBeUndefined()
  })

  test('params appear only with the opt-in', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e), { params: true })
    const { exec } = stubExecutor()
    await exec.all('SELECT ?', ['visible'])
    expect(events[0].params).toEqual(['visible'])
  })

  test('re-registering without the option turns params back off', async () => {
    // The failure this guards: options are per-registration, so a later
    // observer must not inherit an earlier one's opt-in.
    const noisy: QueryEvent[] = []
    setQueryObserver(e => noisy.push(e), { params: true })
    const { exec } = stubExecutor()
    await exec.all('SELECT ?', ['visible'])
    expect(noisy[0].params).toEqual(['visible'])

    const quiet: QueryEvent[] = []
    setQueryObserver(e => quiet.push(e))
    await exec.all('SELECT ?', ['secret'])
    expect(quiet[0].params).toBeUndefined()
  })
})

describe('iterate', () => {
  test('reports once, after the stream ends, with rows consumed', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor('sqlite', { delayMs: 15 })

    const seen: unknown[] = []
    for await (const row of exec.iterate('SELECT * FROM t')) {
      // Nothing must be reported until the stream is done — the whole point of
      // measuring an iterate to its end rather than to its first row.
      expect(events.length).toBe(0)
      seen.push(row)
    }

    expect(seen).toEqual(ROWS)
    expect(events.length).toBe(1)
    expect(events[0].method).toBe('iterate')
    expect(events[0].rows).toBe(2)
    expect(events[0].error).toBeNull()
    // Three sleeps of 15ms: the open, then one per row. This is the documented
    // difference from `all` — the duration spans the whole streaming lifetime.
    expect(events[0].ms).toBeGreaterThanOrEqual(35)
  })

  test('an early break still reports, with the rows actually consumed', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const { exec } = stubExecutor()

    for await (const _row of exec.iterate('SELECT * FROM t')) break

    expect(events.length).toBe(1)
    expect(events[0].rows).toBe(1)
  })

  test('a stream that throws mid-flight reports and rethrows', async () => {
    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    const exec = createExecutor(
      async () => ROWS,
      async () => ({ lastInsertRowid: null, changes: 0 }),
      'sqlite',
      {
        iterate: async function* () {
          yield ROWS[0]
          throw new Error('stream died')
        },
      },
    )

    const seen: unknown[] = []
    const drain = async () => {
      for await (const row of exec.iterate('SELECT 1')) seen.push(row)
    }

    await expect(drain()).rejects.toThrow('stream died')
    await Bun.sleep(5)

    expect(seen).toEqual([ROWS[0]])
    expect(events.length).toBe(1)
    expect(events[0].rows).toBe(1)
    expect((events[0].error as Error).message).toBe('stream died')
  })

  test('a source that is not iterable fails the same way it does unobserved', async () => {
    // Bun's SQL query object is a thenable with no iterator, so this is the
    // shape all three adapters actually hand over today. Observability must not
    // paper over that, and must not change where the failure surfaces.
    const notIterable = {
      then: () => {},
    } as unknown as AsyncIterable<SQLAdapter.RowRecord>
    const exec = createExecutor(
      async () => ROWS,
      async () => ({ lastInsertRowid: null, changes: 0 }),
      'sqlite',
      { iterate: () => notIterable },
    )

    const unobserved = async () => {
      for await (const _row of exec.iterate('SELECT 1')) {
        // never reached
      }
    }
    await expect(unobserved()).rejects.toThrow()

    const events: QueryEvent[] = []
    setQueryObserver(e => events.push(e))
    await expect(unobserved()).rejects.toThrow()
    await Bun.sleep(5)

    expect(events.length).toBe(1)
    expect(events[0].error).not.toBeNull()
    expect(events[0].rows).toBe(0)
  })
})
