import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteAdapter } from '../adapters/sqlite'
import { __resetTestDb, __setTestDb } from '../connection'
import { collectConstraints, type InsertOf, type RowOf, table } from '../define'
import { Field } from '../field'
import { DB } from '../orm/index'
import {
  alive,
  type Isolated,
  isolatedName,
  LIVE_TIMEOUT,
  ownDatabase,
  ownSchema,
} from '../tests/isolated'
import type * as SyncTypes from '../sync/types'
import { checkSchema, sqlColumnsIn } from './check'
import { runMigrations } from './index'

const MYSQL_URL = process.env.MYSQL_TEST_URL
const PGSQL_URL = process.env.PGSQL_TEST_URL

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'bakery-migrate-check-'))
  dirs.push(dir)
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text)
  }
  return dir
}

/** A schema module the way `loadSchema` would hand it to the check. */
const declared = (module: Record<string, unknown>) =>
  collectConstraints(module) as SyncTypes.DBConstraints

const problemsOf = async (
  ...args: Parameters<typeof checkSchema>
): Promise<string[]> =>
  (await alive(checkSchema(...args))).map(mismatch => mismatch.problem)

describe('checkSchema on SQLite', () => {
  test('a schema that matches reports nothing; each kind of mismatch is named', async () => {
    const adapter = new SQLiteAdapter(':memory:')
    try {
      await adapter.executeScript(
        'CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(40) NOT NULL, capacity INTEGER);',
      )
      const rooms = table('rooms', {
        id: Field.Primary(),
        name: Field.Varchar(40),
        capacity: Field.Int(null),
      })
      expect(await problemsOf(adapter, declared({ rooms }))).toEqual([])

      const wrong = table('rooms', {
        id: Field.Primary(),
        name: Field.Varchar(40, null),
        capacity: Field.String(),
        missing: Field.Int(),
      })
      const ghosts = table('ghosts', { id: Field.Primary() })
      expect(await problemsOf(adapter, declared({ wrong, ghosts }))).toEqual([
        'rooms.name: declared nullable, and the database has it NOT NULL.',
        'rooms.capacity: declared text, the database has integer.',
        'rooms.capacity: declared NOT NULL, and the database allows NULL.',
        'rooms.missing is declared, and the table has no such column.',
        'ghosts is declared, and the database has no table or view by that name.',
      ])
    } finally {
      await adapter.close()
    }
  })
})

describe('sqlColumnsIn', () => {
  test('finds the Field.Sql columns classic sync has to refuse', () => {
    const t = table('t', {
      id: Field.Primary(),
      weight: Field.Sql<string>('numeric(5,2)'),
    })
    expect(sqlColumnsIn(declared({ t }))).toEqual(['t.weight'])
  })
})

describe.skipIf(!PGSQL_URL)('checkSchema on Postgres, after migrations', () => {
  let pg: Isolated

  beforeAll(async () => {
    pg = await ownSchema(PGSQL_URL!)
    const dir = folder({
      '0001_campuses.sql': `
        CREATE TABLE campuses (
          id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name text NOT NULL,
          is_main boolean NOT NULL DEFAULT false,
          weight numeric(5,2) NOT NULL CHECK (weight BETWEEN 0 AND 100),
          tags text[] NOT NULL DEFAULT '{}',
          opened_at timestamptz NOT NULL DEFAULT now(),
          closed_at timestamptz
        );
        -- Exactly one main campus.
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
      '0003_terms.sql': `
        CREATE TYPE term AS ENUM ('first', 'second');
        CREATE TABLE secrets (id integer PRIMARY KEY, term term NOT NULL);
      `,
    })
    await alive(runMigrations(pg.adapter, dir, { apply: true }))
  }, LIVE_TIMEOUT)

  afterAll(async () => {
    await pg.drop()
  }, LIVE_TIMEOUT)

  const campuses = table('campuses', {
    id: Field.Primary(),
    name: Field.String(),
    isMain: Field.Bool(false),
    weight: Field.Sql<string>('numeric(5,2)'),
    tags: Field.Sql<string[]>('text[]', { optional: true }),
    openedAt: Field.Sql<Date>('timestamptz', { optional: true }),
    closedAt: Field.Sql<Date>('timestamptz', { nullable: true }),
  })
  const secrets = table('secrets', {
    id: Field.Int(),
    term: Field.Enum(['first', 'second']),
  })

  test(
    'declarations that match report nothing, and what only SQL can say is kept',
    async () => {
      expect(
        await problemsOf(pg.adapter, declared({ campuses, secrets })),
      ).toEqual([])

      // The check reads the catalog and writes nothing: the CHECK, the
      // trigger and the partial unique index are all still in place.
      const kept = (await alive(
        pg.adapter
          .query(
            `SELECT
               (SELECT count(*) FROM pg_constraint
                 WHERE contype = 'c' AND conrelid = 'campuses'::regclass) AS checks,
               (SELECT count(*) FROM pg_trigger
                 WHERE tgname = 'campuses_touch') AS triggers,
               (SELECT count(*) FROM pg_indexes
                 WHERE schemaname = current_schema()
                   AND indexname = 'one_main_campus') AS partial`,
          )
          .get(),
      )) as Record<string, unknown>
      expect({
        checks: Number(kept.checks),
        triggers: Number(kept.triggers),
        partial: Number(kept.partial),
      }).toEqual({ checks: 1, triggers: 1, partial: 1 })
    },
    LIVE_TIMEOUT,
  )

  test(
    'declarations that disagree are each reported',
    async () => {
      const wrong = table('campuses', {
        id: Field.Primary(),
        name: Field.String(null),
        weight: Field.Float(),
        tags: Field.Sql<number[]>('integer[]'),
        closedAt: Field.Sql<Date>('timestamptz'),
        missing: Field.Int(),
      })
      expect(await problemsOf(pg.adapter, declared({ wrong }))).toEqual([
        'campuses.name: declared nullable, and the database has it NOT NULL.',
        'campuses.weight: declared a float (double precision or real), the database has numeric(5,2).',
        'campuses.tags: declared integer[], the database has text[].',
        'campuses.closed_at: declared NOT NULL, and the database allows NULL.',
        'campuses.missing is declared, and the table has no such column.',
      ])
    },
    LIVE_TIMEOUT,
  )

  test(
    "a native enum's labels are read from the catalog",
    async () => {
      const terms = table('secrets', {
        id: Field.Int(),
        term: Field.Enum(['first', 'third']),
      })
      expect(await problemsOf(pg.adapter, declared({ terms }))).toEqual([
        "secrets.term: declared the values first, third, the database's enum has first, second.",
      ])
    },
    LIVE_TIMEOUT,
  )

  test(
    'a role with no privilege on a table still has it checked',
    async () => {
      // The app's role, which may hold nothing on some tables at all.
      // information_schema hides such a table from it entirely (measured);
      // the catalog the check reads does not.
      const role = isolatedName()
      await alive(
        pg.adapter.executeScript(
          `CREATE ROLE "${role}" NOLOGIN;
           GRANT USAGE ON SCHEMA "${pg.name}" TO "${role}";
           GRANT SELECT ON campuses TO "${role}";`,
        ),
      )
      const restricted = pg.another()
      try {
        await alive(restricted.executeScript(`SET ROLE "${role}"`))
        expect(
          await problemsOf(restricted, declared({ campuses, secrets })),
        ).toEqual([])
      } finally {
        await restricted.close()
        await alive(
          pg.adapter.executeScript(
            `REVOKE ALL ON campuses FROM "${role}";
             REVOKE ALL ON SCHEMA "${pg.name}" FROM "${role}";
             DROP ROLE "${role}";`,
          ),
        )
      }
    },
    LIVE_TIMEOUT,
  )

  test(
    'a query typed by the declarations reads the migrated table',
    async () => {
      await alive(
        pg.adapter.executeScript(
          "INSERT INTO campuses (name, is_main, weight, tags) VALUES ('north', true, 42.5, '{science,arts}')",
        ),
      )
      __setTestDb(pg.adapter)
      try {
        const rows = (await alive(
          DB.from('campuses').selectAll('campuses').array(),
        )) as RowOf<typeof campuses>[]
        const row = rows[0]!
        // What Bun hands back, which is what the declarations promise.
        expect(row.weight).toBe('42.50')
        expect(row.tags).toEqual(['science', 'arts'])
        expect(row.openedAt).toBeInstanceOf(Date)
        expect(row.closedAt).toBeNull()
        // The trigger ran.
        expect(row.name).toBe('NORTH')
      } finally {
        __resetTestDb()
      }

      // And the types say the same, checked by the compiler: the column the
      // database fills is optional on insert, and a numeric is a string.
      const insert: InsertOf<typeof campuses> = {
        name: 'south',
        weight: '10.00',
      }
      // @ts-expect-error numeric(5,2) comes back from Bun as a string
      const weight: RowOf<typeof campuses>['weight'] = 1
      void insert
      void weight
    },
    LIVE_TIMEOUT,
  )
})

describe.skipIf(!MYSQL_URL)('checkSchema on MySQL', () => {
  test(
    'declarations that match report nothing; a width and an enum that differ are named',
    async () => {
      const my = await ownDatabase(MYSQL_URL!)
      try {
        await alive(
          my.adapter.executeScript(
            "CREATE TABLE rooms (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(40) NOT NULL, status ENUM('draft','live') NOT NULL, weight DECIMAL(5,2) NOT NULL)",
          ),
        )
        const rooms = table('rooms', {
          id: Field.Primary(),
          name: Field.Varchar(40),
          status: Field.Enum(['draft', 'live']),
          weight: Field.Sql<string>('decimal(5,2)'),
        })
        expect(await problemsOf(my.adapter, declared({ rooms }))).toEqual([])

        const wrong = table('rooms', {
          id: Field.Primary(),
          name: Field.Varchar(64),
          status: Field.Enum(['draft']),
        })
        expect(await problemsOf(my.adapter, declared({ wrong }))).toEqual([
          'rooms.name: declared varchar(64), the database has varchar(40).',
          "rooms.status: declared the values draft, the database's enum has draft, live.",
        ])
      } finally {
        await my.drop()
      }
    },
    LIVE_TIMEOUT,
  )
})
