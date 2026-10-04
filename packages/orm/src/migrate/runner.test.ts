import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SQLAdapter } from '../adapters/base'
import { SQLiteAdapter } from '../adapters/sqlite'
import {
  alive,
  type Isolated,
  LIVE_TIMEOUT,
  ownDatabase,
  ownSchema,
} from '../tests/isolated'
import { checksumOf, type MigrationFile } from './files'
import { runMigrations } from './index'
import { MigrationError, planMigrations, readApplied } from './runner'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

const file = (
  name: string,
  text: string,
  transaction = true,
): MigrationFile => ({
  name,
  order: BigInt(name.split('_')[0]!),
  path: name,
  text,
  checksum: checksumOf(text),
  transaction,
})

const PG = { transactionalDDL: true, dialect: 'pgsql' as const }
const MYSQL = { transactionalDDL: false, dialect: 'mysql' as const }

describe('planMigrations', () => {
  const one = file('0001_a.sql', 'CREATE TABLE a (id int);')
  const two = file('0002_b.sql', 'CREATE TABLE b (id int);')

  test('nothing applied: every file is pending, in order', () => {
    const plan = planMigrations([one, two], [], PG)
    expect(plan.pending.map(f => f.name)).toEqual(['0001_a.sql', '0002_b.sql'])
    expect(plan.problems).toEqual([])
  })

  test('applied files are not pending', () => {
    const plan = planMigrations(
      [one, two],
      [{ name: one.name, checksum: one.checksum, appliedAt: 0 }],
      PG,
    )
    expect(plan.pending.map(f => f.name)).toEqual(['0002_b.sql'])
  })

  test('an applied file that changed refuses the run', () => {
    const plan = planMigrations(
      [one, two],
      [{ name: one.name, checksum: 'edited', appliedAt: 1_759_000_000 }],
      PG,
    )
    expect(plan.problems).toEqual([
      '0001_a.sql changed after it ran on 2025-09-27. Undo the edit, and write the change as a new migration.',
    ])
  })

  test('an applied file that is gone refuses the run', () => {
    const plan = planMigrations(
      [two],
      [{ name: one.name, checksum: one.checksum, appliedAt: 1_759_000_000 }],
      PG,
    )
    expect(plan.problems[0]).toContain(
      '0001_a.sql ran on 2025-09-27 and is no longer in the folder',
    )
  })

  test('a new file that sorts before one that ran refuses the run', () => {
    // Two branches, each adding a migration: the one merged second must not
    // run in the past.
    const between = file('0001_z.sql', 'CREATE TABLE z (id int);')
    const plan = planMigrations(
      [one, between, two],
      [one, two].map(f => ({
        name: f.name,
        checksum: f.checksum,
        appliedAt: 0,
      })),
      PG,
    )
    expect(plan.problems).toEqual([
      '0001_z.sql sorts before 0002_b.sql, which has already run. Renumber it to sort after 0002_b.sql.',
    ])
  })

  test('transaction control in a file refuses the run, by line', () => {
    const commits = file(
      '0001_c.sql',
      'BEGIN;\nCREATE TABLE c (id int);\nCOMMIT;',
    )
    expect(planMigrations([commits], [], PG).problems).toEqual([
      '0001_c.sql, line 1: BEGIN would end the transaction the file runs in and commit part of it. Remove it; each file is committed whole.',
      '0001_c.sql, line 3: COMMIT would end the transaction the file runs in and commit part of it. Remove it; each file is committed whole.',
    ])
  })

  test('on MySQL there is no transaction to escape', () => {
    const commits = file(
      '0001_c.sql',
      'BEGIN;\nCREATE TABLE c (id int);\nCOMMIT;',
    )
    expect(planMigrations([commits], [], MYSQL).problems).toEqual([])
  })

  test('a file outside a transaction holds one statement', () => {
    const two = file(
      '0001_i.sql',
      '-- bakery:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (x); CREATE INDEX CONCURRENTLY j ON t (y);',
      false,
    )
    expect(planMigrations([two], [], PG).problems).toEqual([
      '0001_i.sql runs outside a transaction, so it may hold one statement, and it holds 2. Move the others into a file of their own.',
    ])
    const single = file(
      '0002_i.sql',
      'CREATE INDEX CONCURRENTLY i ON t (x);',
      false,
    )
    expect(planMigrations([single], [], PG).problems).toEqual([])
  })
})

type Live = {
  name: string
  skip: boolean
  open: () => Promise<Isolated>
}

const LIVE: Live[] = [
  {
    name: 'SQLite',
    skip: false,
    open: async () => {
      const adapter = new SQLiteAdapter(':memory:')
      return {
        adapter,
        name: ':memory:',
        another: () => adapter,
        drop: () => adapter.close(),
      }
    },
  },
  { name: 'Postgres', skip: !PGSQL_URL, open: () => ownSchema(PGSQL_URL!) },
  { name: 'MySQL', skip: !MYSQL_URL, open: () => ownDatabase(MYSQL_URL!) },
]

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bakery-migrate-run-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text)
  return dir
}

async function tableNames(adapter: SQLAdapter): Promise<string[]> {
  const constraints = await adapter.getConstraints()
  return Object.keys(constraints).sort()
}

for (const { name, skip, open } of LIVE) {
  describe(`runMigrations on ${name}`, () => {
    let adapter: SQLAdapter
    let drop: () => Promise<void>

    beforeAll(async () => {
      if (skip) return
      ;({ adapter, drop } = await open())
    }, LIVE_TIMEOUT)

    afterAll(async () => {
      if (!skip) await drop()
    }, LIVE_TIMEOUT)

    test.skipIf(skip)(
      'applies in order, records each file, and runs nothing twice',
      async () => {
        const dir = folder({
          '0001_rooms.sql':
            'CREATE TABLE rooms (id INTEGER PRIMARY KEY, name VARCHAR(40) NOT NULL);',
          '0002_notes.sql':
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, body VARCHAR(80));\nINSERT INTO notes (id, body) VALUES (1, 'semi; colon');",
        })
        const first = await alive(runMigrations(adapter, dir, { apply: true }))
        expect(first).toEqual({
          applied: ['0001_rooms.sql', '0002_notes.sql'],
          pending: ['0001_rooms.sql', '0002_notes.sql'],
          problems: [],
        })

        const ledger = await alive(readApplied(adapter))
        expect(ledger.map(row => row.name).sort()).toEqual([
          '0001_rooms.sql',
          '0002_notes.sql',
        ])
        expect(ledger.every(row => row.checksum.length === 64)).toBe(true)
        expect(ledger.every(row => row.appliedAt > 1_700_000_000)).toBe(true)

        const again = await alive(runMigrations(adapter, dir, { apply: true }))
        expect(again).toEqual({ applied: [], pending: [], problems: [] })
      },
      LIVE_TIMEOUT,
    )

    test.skipIf(skip)(
      'a file that fails stops the run, and records nothing',
      async () => {
        const dir = folder({
          '0001_rooms.sql':
            'CREATE TABLE rooms (id INTEGER PRIMARY KEY, name VARCHAR(40) NOT NULL);',
          '0002_notes.sql':
            "CREATE TABLE notes (id INTEGER PRIMARY KEY, body VARCHAR(80));\nINSERT INTO notes (id, body) VALUES (1, 'semi; colon');",
          '0003_half.sql':
            'CREATE TABLE half_done (id INTEGER);\nCREATE TABLE rooms (id INTEGER);',
          '0004_after.sql': 'CREATE TABLE after_failure (id INTEGER);',
        })
        let error: unknown
        try {
          await alive(runMigrations(adapter, dir, { apply: true }))
        } catch (caught) {
          error = caught
        }
        expect(error).toBeInstanceOf(MigrationError)
        const failure = error as MigrationError
        expect(failure.file.name).toBe('0003_half.sql')

        const tables = await alive(tableNames(adapter))
        expect(tables).not.toContain('afterFailure')
        expect(
          (await alive(readApplied(adapter))).map(row => row.name),
        ).not.toContain('0003_half.sql')

        if (adapter.transactionalDDL) {
          // Rolled back whole: the table the first statement made is gone.
          expect(failure.rolledBack).toBe(true)
          expect(tables).not.toContain('halfDone')
        } else {
          // MySQL commits each DDL statement: the first one stays, and the
          // message says to check the database.
          expect(failure.rolledBack).toBe(false)
          expect(tables).toContain('halfDone')
          expect(failure.message).toContain(
            'statements before the failure stay applied',
          )
        }
      },
      LIVE_TIMEOUT,
    )
  })
}

/** A Postgres schema for one test, dropped when the test is done. */
async function withPg(run: (pg: Isolated) => Promise<void>): Promise<void> {
  const pg = await ownSchema(PGSQL_URL!)
  try {
    await run(pg)
  } finally {
    await pg.drop()
  }
}

describe.skipIf(!PGSQL_URL)(
  'Postgres: what the declarations cannot say',
  () => {
    test(
      'a CHECK, a trigger and a partial unique index are created and enforced',
      () =>
        withPg(async ({ adapter }) => {
          const dir = folder({
            '0001_campus.sql': `
            CREATE TABLE campuses (
              id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
              name text NOT NULL,
              is_main boolean NOT NULL DEFAULT false,
              weight numeric(5,2) NOT NULL CHECK (weight BETWEEN 0 AND 100),
              updated_at timestamptz NOT NULL DEFAULT now()
            );
            -- Exactly one main campus; any number of others.
            CREATE UNIQUE INDEX one_main_campus ON campuses (is_main) WHERE is_main;
          `,
            '0002_touch.sql': `
            CREATE FUNCTION touch() RETURNS trigger AS $$
            BEGIN
              NEW.name := upper(NEW.name);
              RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
            CREATE TRIGGER campuses_touch BEFORE INSERT ON campuses
              FOR EACH ROW EXECUTE FUNCTION touch();
          `,
          })
          const result = await alive(
            runMigrations(adapter, dir, { apply: true }),
          )
          expect(result.applied).toEqual(['0001_campus.sql', '0002_touch.sql'])

          await alive(
            adapter.executeScript(
              "INSERT INTO campuses (name, is_main, weight) VALUES ('north', true, 50), ('south', false, 25), ('east', false, 25)",
            ),
          )
          const rows = (await alive(
            adapter.query('SELECT name FROM campuses ORDER BY name').all(),
          )) as { name: string }[]
          expect(rows.map(row => row.name)).toEqual(['EAST', 'NORTH', 'SOUTH'])

          for (const refused of [
            // A second main campus: the partial unique index.
            "INSERT INTO campuses (name, is_main, weight) VALUES ('west', true, 10)",
            // A weight over 100: the CHECK.
            "INSERT INTO campuses (name, weight) VALUES ('west', 101)",
          ]) {
            let error: unknown
            try {
              await alive(adapter.executeScript(refused))
            } catch (caught) {
              error = caught
            }
            expect(error).toBeDefined()
          }
        }),
      LIVE_TIMEOUT,
    )

    test(
      'a no-transaction file can build an index concurrently',
      () =>
        withPg(async ({ adapter }) => {
          const dir = folder({
            '0001_campus.sql':
              'CREATE TABLE campuses (id integer PRIMARY KEY, name text);',
            '0002_index.sql':
              '-- bakery:no-transaction\nCREATE INDEX CONCURRENTLY campuses_name ON campuses (name);',
          })
          const result = await alive(
            runMigrations(adapter, dir, { apply: true }),
          )
          expect(result.problems).toEqual([])
          const index = (await alive(
            adapter
              .query(
                "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'campuses_name'",
              )
              .all(),
          )) as unknown[]
          expect(index.length).toBe(1)
        }),
      LIVE_TIMEOUT,
    )

    test(
      'a second run started meanwhile waits for the lock, then has nothing to do',
      () =>
        withPg(async ({ adapter, another }) => {
          const dir = folder({
            '0001_slow.sql':
              'CREATE TABLE slow (id integer); SELECT pg_sleep(0.5);',
          })
          const second = another()
          try {
            const [a, b] = await alive(
              Promise.all([
                runMigrations(adapter, dir, { apply: true }),
                Bun.sleep(100).then(() =>
                  runMigrations(second, dir, { apply: true }),
                ),
              ]),
            )
            expect([...a.applied, ...b.applied]).toEqual(['0001_slow.sql'])
            expect(b.pending).toEqual([])
          } finally {
            await second.close()
          }
        }),
      LIVE_TIMEOUT,
    )
  },
)
