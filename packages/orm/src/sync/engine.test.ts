import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { setLogCallback } from '@bakery/core/logger'
import { SQLiteAdapter } from '../adapters/sqlite'
import { isProductionSync, SyncEngine } from './engine'
import { buildSyncPlan, executeSyncPlan } from './helpers'

/**
 * The two guards in `SyncEngine` that were not doing their job.
 *
 * Both are about the same thing from opposite ends: one decides whether a
 * destructive plan may run unattended, the other decides what ends up in the
 * plan at all. Neither is observable from the outside without driving the
 * engine, which is why they went unnoticed.
 */

// ---------------------------------------------------------------------------

describe('the production guard reads a boolean, not the string "true"', () => {
  const original = {
    NODE_ENV: Object.getOwnPropertyDescriptor(process.env, 'NODE_ENV'),
    PROD: Object.getOwnPropertyDescriptor(process.env, 'PROD'),
  }

  function restore(key: 'NODE_ENV' | 'PROD') {
    delete (process.env as Record<string, unknown>)[key]
    const desc = original[key]
    if (desc) Object.defineProperty(process.env, key, desc)
  }

  /** Exactly what `core/init.ts` installs: a getter returning a boolean. */
  function installProdFlag(value: boolean) {
    Object.defineProperty(process.env, 'PROD', {
      get: () => value,
      enumerable: true,
      configurable: true,
    })
  }

  afterEach(() => {
    restore('NODE_ENV')
    restore('PROD')
  })

  test('the PROD flag alone does not make a sync a deployment', () => {
    // The original code compared `process.env.PROD` against the *string*
    // 'true' while init.ts installs a getter returning a boolean, so the term
    // never fired. Deleting it is deliberate, and this pins that: `PROD` means
    // only "--dev is absent", and `db:sync` never passes --dev, so honouring
    // the flag would make every standalone sync count as production and leave
    // the interactive confirm unreachable.
    process.env.NODE_ENV = 'development'
    installProdFlag(true)
    expect(isProductionSync()).toBe(false)
  })

  test('a false PROD flag is not production either', () => {
    process.env.NODE_ENV = 'development'
    installProdFlag(false)
    expect(isProductionSync()).toBe(false)
  })

  test('NODE_ENV alone still decides it, with no flag installed', () => {
    delete (process.env as Record<string, unknown>).PROD
    process.env.NODE_ENV = 'production'
    expect(isProductionSync()).toBe(true)
  })

  test('neither signal present is not production', () => {
    // A process that never imported core/init.ts — a bare unit test, say —
    // must not be treated as a deployment.
    delete (process.env as Record<string, unknown>).PROD
    process.env.NODE_ENV = 'development'
    expect(isProductionSync()).toBe(false)
  })
})

// ---------------------------------------------------------------------------

/**
 * `adjustSqlitePlan` rebuilt every renamed table and then emptied
 * `columnsToRename` whenever any column rename existed at all. It dated from
 * SQLite before 3.25 having no `ALTER TABLE … RENAME COLUMN`; Bun ships 3.53,
 * and `adapters/ddl.test.ts` already proves the statement works.
 *
 * Measured against a real database before removing it, the special case:
 *   - dropped a rename in a table nothing else touched, leaving the sync to
 *     report a *perfect* sync while the column kept its old name — forever,
 *     since the next run re-derives and re-discards the same plan;
 *   - threw `Object.entries requires that input parameter not be null or
 *     undefined` when a table rename and an unrelated column rename coincided,
 *     because the table it added to `tablesToRebuild` is keyed by its *old*
 *     name and `constraints` has no such entry;
 *   - threw `NOT NULL constraint failed` when a rename and a rebuild landed on
 *     the same table, because the rebuild copies by *new* column name and the
 *     rename that would have produced it had just been discarded.
 *
 * The first two are pinned through `SyncEngine.run`, which is where it was
 * called from; the rest execute the plan and check the rows.
 */
describe('SQLite column renames survive planning', () => {
  const schemaPath = path.join(
    tmpdir(),
    `bakery-engine-${process.pid}-${Date.now()}.ts`,
  )
  const open: SQLiteAdapter[] = []

  beforeAll(async () => {
    // `checkEmptyConstraints` bails out and generates a schema when the file is
    // absent; its contents are never read here.
    await Bun.write(schemaPath, '// fixture\n')
  })

  afterAll(async () => {
    for (const db of open) await db.close()
    rmSync(schemaPath, { force: true })
  })

  function fresh(): SQLiteAdapter {
    const db = new SQLiteAdapter(':memory:')
    open.push(db)
    return db
  }

  /** Run a real dry-run sync and collect the structured messages it emitted. */
  async function dryRun(
    db: SQLiteAdapter,
    constraints: Record<string, unknown>,
  ): Promise<string> {
    const lines: string[] = []
    const argv = process.argv
    setLogCallback(entry => void lines.push(entry.msg))
    process.argv = ['bun', 'db:sync', '--dry-run']
    try {
      await SyncEngine.run(db as any, constraints as any, {}, schemaPath)
    } finally {
      process.argv = argv
      setLogCallback(() => {})
    }
    return lines.join('\n')
  }

  const pk = { type: 'integer', primary: true, autoIncrement: true }

  test('a rename in a table nothing else touches is planned, not swallowed', async () => {
    const db = fresh()
    await db
      .query(
        'CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL)',
      )
      .run()

    const out = await dryRun(db, {
      people: { id: pk, displayName: { type: 'string', _oldColumn: 'oldName' } },
    })

    expect(out).toContain('Columns to rename')
    expect(out).toContain('people.old_name -> display_name')
    // The dangerous half of the bug: with the rename discarded this was the
    // only thing the plan contained, so the engine reported success.
    expect(out).not.toContain('perfectly synced')
  })

  test('a table rename and an unrelated column rename coexist', async () => {
    const db = fresh()
    await db
      .query('CREATE TABLE old_widgets (id INTEGER PRIMARY KEY AUTOINCREMENT)')
      .run()
    await db
      .query(
        'CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL)',
      )
      .run()

    const out = await dryRun(db, {
      widgets: { id: pk, _oldTable: 'oldWidgets' },
      people: { id: pk, displayName: { type: 'string', _oldColumn: 'oldName' } },
    })

    expect(out).toContain('old_widgets -> widgets')
    expect(out).toContain('people.old_name -> display_name')
    // The renamed table was converted into a rebuild keyed by its old name,
    // which then threw on execution because `constraints.oldWidgets` does not
    // exist. Nothing here should be rebuilt at all.
    expect(out).not.toContain('Tables to rebuild')
  })
})

describe('SQLite column renames survive execution', () => {
  const open: SQLiteAdapter[] = []
  const silent: any = new Proxy({}, { get: () => () => {} })
  const logger: any = {
    log: () => {},
    // Every rename below is resolved by an `old()` wrapper, so reaching the
    // interactive matcher means the plan was built wrong.
    selectIndex: (msg: string) => {
      throw new Error(`unexpected prompt: ${msg}`)
    },
  }

  afterAll(async () => {
    for (const db of open) await db.close()
  })

  function fresh(): SQLiteAdapter {
    const db = new SQLiteAdapter(':memory:')
    open.push(db)
    return db
  }

  async function apply(
    db: SQLiteAdapter,
    constraints: Record<string, unknown>,
  ) {
    const plan = await buildSyncPlan(db as any, constraints as any, logger, silent)
    await executeSyncPlan(
      db as any,
      plan,
      constraints as any,
      new Set(),
      new Map(),
      silent,
    )
  }

  const pk = { type: 'integer', primary: true, autoIncrement: true }

  test('the column is renamed and every row keeps its value', async () => {
    const db = fresh()
    await db
      .query(
        'CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL)',
      )
      .run()
    await db.query("INSERT INTO people (old_name) VALUES ('ann'), ('bob')").run()

    await apply(db, {
      people: { id: pk, displayName: { type: 'string', _oldColumn: 'oldName' } },
    })

    const cols = Object.keys((await db.getConstraints()).people)
    expect(cols).toContain('displayName')
    expect(cols).not.toContain('oldName')
    expect(await db.query('SELECT display_name FROM people').all()).toEqual([
      { display_name: 'ann' },
      { display_name: 'bob' },
    ])
  })

  test('a rename and a rebuild on the same table keep the data', async () => {
    // The column type change forces a rebuild, and the rebuild copies columns
    // by their *new* names — which only exist because the rename ran first.
    const db = fresh()
    await db
      .query(
        'CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL, score TEXT NOT NULL)',
      )
      .run()
    await db
      .query("INSERT INTO people (old_name, score) VALUES ('ann', '5')")
      .run()

    await apply(db, {
      people: {
        id: pk,
        displayName: { type: 'string', _oldColumn: 'oldName' },
        score: { type: 'integer' },
      },
    })

    expect(await db.query('SELECT display_name, score FROM people').all()).toEqual(
      [{ display_name: 'ann', score: 5 }],
    )
  })

  test('a view over the renamed column does not block the rename', async () => {
    // The likeliest reason to keep the special case: SQLite rewrites view and
    // index definitions on RENAME COLUMN and refuses if it cannot. It can.
    const db = fresh()
    await db
      .query(
        'CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, old_name TEXT NOT NULL)',
      )
      .run()
    await db.query("INSERT INTO people (old_name) VALUES ('ann')").run()
    await db.query('CREATE VIEW people_names AS SELECT old_name FROM people').run()

    await apply(db, {
      people: { id: pk, displayName: { type: 'string', _oldColumn: 'oldName' } },
      peopleNames: {
        _view: 'SELECT display_name FROM people',
        displayName: { type: 'string', nullable: true },
      },
    })

    expect(await db.query('SELECT * FROM people_names').all()).toEqual([
      { display_name: 'ann' },
    ])
  })
})
