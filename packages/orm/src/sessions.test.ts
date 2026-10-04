import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  __resetTestConfig,
  __setTestConfig,
  initConfig,
} from '@bakery-framework/core/core/config'
import { Session, type StoredSession } from '@bakery-framework/core/session'
import type { SQLAdapter } from './adapters/base'
import { SQLiteAdapter } from './adapters/sqlite'
import { __resetTestDb, __setTestDb } from './connection'
import { Field } from './field'
import { DB } from './orm'
import { databaseSessions } from './sessions'
import { executeSyncPlan } from './sync/execute'
import { buildSyncPlan, calculateIndexDiff } from './sync/plan'
import { alive, LIVE_TIMEOUT, ownDatabase, ownSchema } from './tests/isolated'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

/**
 * The table exactly as docs/guides/sessions.md gives it. The tests run the
 * guide's own SQL on all three dialects, so the documented table and the one
 * the store is tested against cannot drift apart.
 */
const TABLE_SQL = (() => {
  const guide = readFileSync(
    join(import.meta.dir, '../../../docs/guides/sessions.md'),
    'utf8',
  )
  const block = guide.match(/```sql\n(CREATE TABLE bakery_sessions[\s\S]*?)```/)
  if (!block)
    throw new Error('docs/guides/sessions.md gives no bakery_sessions table')
  return block[1]!
})()

const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const BACKSLASH = String.fromCharCode(92)

let serial = 0
/** An id shaped like the ones `newSessionId` mints, unique within the run. */
const newId = () => `${process.pid}x${serial++}`.padEnd(43, 'A')

function stored(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: newId(),
    host: '',
    account: '7',
    createdAt: NOW - 5_000,
    accessedAt: NOW - 1_000,
    expiresAt: NOW + HOUR,
    persistKeys: ['accountId'],
    data: {
      accountId: 7,
      version: 3,
      name: `Ña "quoted" ${BACKSLASH} {braced}`,
      nested: { roles: ['registrar'] },
    },
    ...overrides,
  }
}

type Opened = { adapter: SQLAdapter; drop: () => Promise<void> }

async function openSqlite(): Promise<Opened> {
  const adapter = new SQLiteAdapter(':memory:')
  return { adapter, drop: () => adapter.close() }
}

/**
 * The store's contract on one dialect, against the guide's table. One
 * `describe` per dialect, each pointing the ORM's connection at its own
 * database for the length of the block.
 */
function contract(dialect: string, skip: boolean, open: () => Promise<Opened>) {
  describe.skipIf(skip)(`the database session store on ${dialect}`, () => {
    const store = databaseSessions()
    let db: Opened

    beforeAll(async () => {
      db = await open()
      await alive(db.adapter.executeScript(TABLE_SQL))
      __setTestDb(db.adapter)
    }, LIVE_TIMEOUT)

    afterAll(async () => {
      __resetTestDb()
      await db.drop()
    }, LIVE_TIMEOUT)

    beforeEach(async () => {
      await alive(db.adapter.query('DELETE FROM bakery_sessions').run())
    })

    test(
      'what it stores is what it loads, numbers as numbers',
      async () => {
        const session = stored()
        await alive(store.insert(session))
        expect(await alive(store.load('', session.id, NOW))).toEqual(session)
      },
      LIVE_TIMEOUT,
    )

    test(
      'it loads nothing for another host, or once expired',
      async () => {
        const session = stored()
        await alive(store.insert(session))
        expect(
          await alive(store.load('b.test', session.id, NOW)),
        ).toBeUndefined()
        expect(
          await alive(store.load('', session.id, session.expiresAt)),
        ).toBeUndefined()
        expect(
          await alive(store.load('', session.id, session.expiresAt - 1)),
        ).toBeDefined()
      },
      LIVE_TIMEOUT,
    )

    test(
      'an update moves a session to its new id',
      async () => {
        const session = stored()
        await alive(store.insert(session))
        const moved = {
          ...session,
          id: newId(),
          data: { accountId: 7, step: 2 },
        }

        expect(await alive(store.update(session.id, moved))).toBe(true)
        expect(await alive(store.load('', session.id, NOW))).toBeUndefined()
        expect(await alive(store.load('', moved.id, NOW))).toEqual(moved)
      },
      LIVE_TIMEOUT,
    )

    test(
      'an update of a session that is gone writes nothing',
      async () => {
        const session = stored()
        expect(await alive(store.update(session.id, session))).toBe(false)
        expect(await alive(store.touch('', session.id, NOW, NOW + HOUR))).toBe(
          false,
        )
        expect(await alive(store.load('', session.id, NOW))).toBeUndefined()
      },
      LIVE_TIMEOUT,
    )

    test(
      'an update that changes nothing still finds its session',
      async () => {
        // MySQL counts the rows an UPDATE changed, not the rows it matched.
        const session = stored()
        await alive(store.insert(session))
        expect(await alive(store.update(session.id, session))).toBe(true)
        expect(
          await alive(
            store.touch('', session.id, session.accessedAt, session.expiresAt),
          ),
        ).toBe(true)
      },
      LIVE_TIMEOUT,
    )

    test(
      'a renewal moves the times and leaves the data',
      async () => {
        const session = stored()
        await alive(store.insert(session))
        expect(
          await alive(store.touch('', session.id, NOW, NOW + 2 * HOUR)),
        ).toBe(true)
        const renewed = await alive(store.load('', session.id, NOW))
        expect(renewed?.accessedAt).toBe(NOW)
        expect(renewed?.expiresAt).toBe(NOW + 2 * HOUR)
        expect(renewed?.data).toEqual(session.data)
      },
      LIVE_TIMEOUT,
    )

    test(
      'remove says whether there was one',
      async () => {
        const session = stored()
        await alive(store.insert(session))
        expect(await alive(store.remove('b.test', session.id))).toBe(false)
        expect(await alive(store.remove('', session.id))).toBe(true)
        expect(await alive(store.remove('', session.id))).toBe(false)
      },
      LIVE_TIMEOUT,
    )

    test(
      'removeAccount ends one account on one host',
      async () => {
        const mine = [stored(), stored()]
        const other = stored({ account: '8' })
        const elsewhere = stored({ host: 'b.test' })
        const anonymous = stored({ account: null })
        for (const s of [...mine, other, elsewhere, anonymous]) {
          await alive(store.insert(s))
        }

        expect(await alive(store.removeAccount('', '7'))).toBe(2)
        for (const s of mine) {
          expect(await alive(store.load('', s.id, NOW))).toBeUndefined()
        }
        expect(await alive(store.load('', other.id, NOW))).toBeDefined()
        expect(
          await alive(store.load('b.test', elsewhere.id, NOW)),
        ).toBeDefined()
        expect(await alive(store.load('', anonymous.id, NOW))).toBeDefined()
      },
      LIVE_TIMEOUT,
    )

    test(
      'count is live sessions across every host',
      async () => {
        await alive(store.insert(stored()))
        await alive(store.insert(stored({ host: 'b.test' })))
        await alive(store.insert(stored({ expiresAt: NOW - 1 })))
        expect(await alive(store.count(NOW))).toBe(2)
      },
      LIVE_TIMEOUT,
    )

    test(
      'list pages, sorts and searches literally',
      async () => {
        const rows = [
          stored({ accessedAt: NOW - 3_000, data: { note: 'rate 50% off' } }),
          stored({ accessedAt: NOW - 2_000, data: { note: 'Rate 5 OFF' } }),
          stored({ accessedAt: NOW - 1_000, persistKeys: [] }),
        ]
        for (const s of rows) await alive(store.insert(s))
        await alive(store.insert(stored({ host: 'b.test' })))

        const recent = await alive(
          store.list(
            '',
            { page: 1, pageSize: 2, sortBy: 'accessed', sortOrder: 'DESC' },
            NOW,
          ),
        )
        expect(recent.totalRows).toBe(3)
        expect(recent.rows.map(r => r.id)).toEqual([rows[2]!.id, rows[1]!.id])

        const past = await alive(
          store.list(
            '',
            { page: 9, pageSize: 2, sortBy: 'accessed', sortOrder: 'DESC' },
            NOW,
          ),
        )
        expect(past.rows.map(r => r.id)).toEqual([rows[0]!.id])

        const byKeys = await alive(
          store.list(
            '',
            { page: 1, pageSize: 1, sortBy: 'keys', sortOrder: 'ASC' },
            NOW,
          ),
        )
        expect(byKeys.rows[0]!.id).toBe(rows[2]!.id)

        const literal = await alive(
          store.list(
            '',
            {
              search: '50%',
              page: 1,
              pageSize: 10,
              sortBy: 'id',
              sortOrder: 'ASC',
            },
            NOW,
          ),
        )
        expect(literal.rows.map(r => r.id)).toEqual([rows[0]!.id])

        const anyCase = await alive(
          store.list(
            '',
            {
              search: 'RATE',
              page: 1,
              pageSize: 10,
              sortBy: 'id',
              sortOrder: 'ASC',
            },
            NOW,
          ),
        )
        expect(anyCase.totalRows).toBe(2)
      },
      LIVE_TIMEOUT,
    )

    test(
      'prune forgets what has expired and keeps the rest',
      async () => {
        const live = stored()
        await alive(store.insert(live))
        await alive(store.insert(stored({ expiresAt: NOW })))
        await alive(store.insert(stored({ expiresAt: NOW - HOUR })))
        expect(await alive(store.prune(NOW))).toBe(2)
        expect(await alive(store.count(0))).toBe(1)
        expect(await alive(store.load('', live.id, NOW))).toBeDefined()
      },
      LIVE_TIMEOUT,
    )

    test(
      'inside DB.transaction it commits and rolls back with the transaction',
      async () => {
        const session = stored()
        await alive(store.insert(session))

        const rolledBack = await alive(
          DB.transaction(async () => {
            await store.removeAccount('', '7')
            throw new Error('the account delete failed')
          }).catch((error: Error) => error.message),
        )
        expect(rolledBack).toBe('the account delete failed')
        expect(await alive(store.load('', session.id, NOW))).toBeDefined()

        await alive(DB.transaction(() => store.removeAccount('', '7')))
        expect(await alive(store.load('', session.id, NOW))).toBeUndefined()
      },
      LIVE_TIMEOUT,
    )

    test(
      'the session layer through it: signed in, read back, ended by account',
      async () => {
        await initConfig()
        __setTestConfig({ sessions: { store, account: 'accountId' } })
        try {
          const request = async (id?: string) => {
            const req = new Request(
              'http://localhost/',
              id ? { headers: { cookie: `sId=${id}` } } : undefined,
            )
            const loading = Session.attach(req)
            if (loading) await alive(loading)
            return req
          }

          const login = await request()
          login.session.regenerate().set('accountId', 7, true)
          expect(await alive(Session.commit(login))).toContain('sId=')
          const id = login.session.id

          expect((await request(id)).session.get('accountId')).toBe(7)
          expect(await alive(Session.endForAccount(7))).toBe(1)
          expect((await request(id)).session.get('accountId')).toBeUndefined()
        } finally {
          __resetTestConfig()
        }
      },
      LIVE_TIMEOUT,
    )
  })
}

contract('SQLite', false, openSqlite)
contract('Postgres', !PGSQL_URL, () => ownSchema(PGSQL_URL!))
contract('MySQL', !MYSQL_URL, () => ownDatabase(MYSQL_URL!))

/**
 * Classic `db:sync` plans a drop for any table the schema leaves out, so an
 * app there declares the table instead. This is the declaration the guide
 * gives, applied the way the engine applies a schema, then held to the store.
 */
describe('the table declared for classic db:sync', () => {
  const constraints = {
    bakerySessions: {
      id: Field.Varchar(64),
      host: Field.Varchar(255, ''),
      account: Field.Varchar(255, null),
      data: Field.Text(),
      persisted: Field.Int(),
      createdAt: Field.BigInt(),
      accessedAt: Field.BigInt(),
      expiresAt: Field.BigInt(),
    },
  } as const
  const indexes = {
    bakerySessionsId: Field.Unique('bakerySessions', ['id']),
    bakerySessionsAccount: Field.Index('bakerySessions', ['account', 'host']),
    bakerySessionsExpires: Field.Index('bakerySessions', ['expiresAt']),
  }
  const quiet = new Proxy({}, { get: () => () => {} })

  async function plan(db: SQLiteAdapter) {
    const built = await buildSyncPlan(
      db,
      constraints as any,
      quiet as any,
      quiet,
    )
    const { indexesToDrop, indexesToAdd } = calculateIndexDiff(
      await db.getIndexes(),
      indexes as any,
      built.tablesToRebuild,
    )
    return { built, indexesToDrop, indexesToAdd }
  }

  test('sync creates it, the store works on it, and a second sync finds nothing to do', async () => {
    const db = new SQLiteAdapter(':memory:')
    try {
      const first = await plan(db)
      expect([...first.built.unmappedTsTables]).toEqual(['bakerySessions'])
      expect(first.indexesToAdd.size).toBe(3)
      await executeSyncPlan({
        tx: db as any,
        plan: first.built,
        constraints: constraints as any,
        indexesToDrop: first.indexesToDrop,
        indexesToAdd: first.indexesToAdd,
        MESSAGES: quiet as any,
      })

      __setTestDb(db)
      const store = databaseSessions()
      const session = stored()
      await store.insert(session)
      expect(await store.load('', session.id, NOW)).toEqual(session)
      expect(await store.removeAccount('', '7')).toBe(1)

      const second = await plan(db)
      expect(second.built.unmappedTsTables.size).toBe(0)
      expect(second.built.tablesToRebuild.size).toBe(0)
      expect(second.built.columnsToAdd.length).toBe(0)
      expect(second.indexesToAdd.size).toBe(0)
      expect(second.indexesToDrop.size).toBe(0)
    } finally {
      __resetTestDb()
      await db.close()
    }
  })
})
