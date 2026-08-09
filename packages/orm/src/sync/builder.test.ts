import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { fs } from '@bakery-framework/core/utils'
import { SQLiteAdapter } from '../adapters/sqlite'
import { collectConstraints } from '../define'
import { SchemaBuilder } from './builder'

const silentMessages: any = new Proxy({}, { get: () => () => {} })

/**
 * `db:sync --choose=db` writes schema.ts from the database, and the sync engine
 * generates one when none exists. Since the framework no longer imports
 * schema.ts for types, a generated file that omits the registration block
 * leaves the ORM silently untyped — it runs, but every column is `any`.
 *
 * That is exactly the failure the schema registry was introduced to prevent, so
 * the generator's output contract is pinned here.
 */
describe('generated schema registers itself', () => {
  async function generate(): Promise<string> {
    const db = new SQLiteAdapter(':memory:')
    await db
      .query(
        'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL, qty INTEGER DEFAULT 0)',
      )
      .run()

    const path = `${Bakery.cacheDir}/__gen-schema-test.ts`
    // Cast: SQLiteAdapter declares parseDefault private while the base does
    // not, so it is not structurally assignable to SQLAdapter. Pre-existing
    // (see the same error at adapters/sqlite.ts:228) and unrelated to this test.
    await SchemaBuilder.generate(db as any, path, silentMessages)
    const source = await Bun.file(path).text()
    await Bun.file(path).delete()
    return source
  }

  test('emits the declare module registration block', async () => {
    const source = await generate()
    expect(source).toContain(
      "declare module '@bakery-framework/orm/schema-registry'",
    )
    expect(source).toContain('interface SchemaRegistry')
  })

  test('registers all three type slots the registry reads', async () => {
    const source = await generate()
    expect(source).toContain('DBSchema: DBSchema')
    expect(source).toContain('DBOptionals: DBOptionals')
    expect(source).toContain('Views: DBInfo.Views')
  })

  test('still emits the DBInfo namespace and derived types', async () => {
    const source = await generate()
    expect(source).toContain('export namespace DBInfo')
    expect(source).toContain('export type DBSchema')
    expect(source).toContain('export type DBOptionals')
    expect(source).toContain('widgets')
  })
})

/**
 * The generator only ever emitted the `DBInfo` namespace. For a project on the
 * `orm/` folder layout the write target is `orm/schema.ts` — which `index.ts`
 * re-exports — so a regeneration replaced every `table()` value with a
 * namespace *and* added a second `declare module '@bakery-framework/orm/schema-registry'`
 * block colliding with the one `index.ts` already declares. `--choose=db` did
 * it on demand; a sync involving `old()` wrappers did it implicitly.
 *
 * It now emits `table()` values for that layout, and tables only: `index.ts`
 * owns the registration and `indexes.ts` owns the constraints, which is the
 * separation the folder layout exists for.
 */
describe('the generated shape follows the layout it is written into', () => {
  async function generate(layout: 'folder' | 'file' | 'none' | undefined) {
    const db = new SQLiteAdapter(':memory:')
    await db
      .query(
        "CREATE TABLE widgets (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, note TEXT, qty INTEGER DEFAULT 0, made_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)))",
      )
      .run()
    await db.createIndex('idx_widgets_label', 'widgets', ['label'], true)

    const path = `${Bakery.cacheDir}/__gen-layout-test.ts`
    await SchemaBuilder.generate(db as any, path, silentMessages, {}, layout)
    const source = await Bun.file(path).text()
    await Bun.file(path).delete()
    await db.close()
    return source
  }

  test('a folder layout gets table() values, not a DBInfo namespace', async () => {
    const source = await generate('folder')

    expect(source).toContain("export const widgets = table('widgets', {")
    expect(source).toContain('id: Field.Primary(),')
    expect(source).toContain('note: Field.String(null),')
    expect(source).toContain('madeAt: Field.Date.now(),')
    expect(source).not.toContain('namespace DBInfo')

    // `qty` is nullable *and* defaults to 0, which `Field` cannot spell: its one
    // convention is that a null default means nullable. Emitting `Field.Int(0)`
    // would quietly turn a nullable column NOT NULL, so it falls through to a
    // plain object literal — constraints *are* objects, so this needs no helper
    // and imports nothing.
    expect(source).toContain(
      "qty: { type: 'integer', default: 0, nullable: true },",
    )

    // `label` is NOT NULL with no default and comes back as nullable. That is
    // the column formatter's long-standing round-trip loss, shared with the
    // DBInfo form and unchanged by the move to `Field`; pinned so the vocabulary
    // change is not blamed for it.
    expect(source).toContain('label: Field.String(null),')
  })

  test('a folder layout never emits a second registration block', async () => {
    // The collision: `orm/index.ts` already declares this module against its
    // own `InferSchema<typeof model>`, and two augmentations of the same
    // interface member do not merge.
    const source = await generate('folder')
    expect(source).not.toContain(
      "declare module '@bakery-framework/orm/schema-registry'",
    )
    expect(source).not.toContain('interface SchemaRegistry')
  })

  test('a folder layout leaves indexes to indexes.ts', async () => {
    const source = await generate('folder')
    expect(source).not.toContain('idxWidgetsLabel')
    expect(source).not.toContain('unique(')
  })

  test('the folder module imports exactly the helpers it used', async () => {
    const source = await generate('folder')
    // Exactly the helpers used, and no more: `Field` and `table`. The column
    // `Field` cannot name is an object literal, and `Field.Date.now()` replaces
    // the old `dateNow` marker import — so neither `value` nor `dateNow`
    // appears, and there is no longer a `value` to import.
    expect(source).toContain(
      "import { Field, table } from '@bakery-framework/orm'",
    )
    expect(source).not.toContain('dateNow')
    expect(source).not.toContain('value(')
  })

  test('the emitted module really is importable, and round-trips', async () => {
    // Written to a real file and imported: a generated schema that does not
    // parse, or whose `table()` values `collectConstraints` cannot read, is the
    // failure this whole change is about.
    //
    // The `@bakery-framework/orm` specifier is rewritten to this package's own entry
    // because the workspace links `@bakery-framework/orm` into the *apps*, not into
    // `packages/orm` itself, so nothing under a temp directory can resolve it.
    // The specifier as emitted is asserted separately above.
    const entry = Bun.pathToFileURL(
      fs.resolve(import.meta.dir, '../index.ts'),
    ).href
    const source = (await generate('folder')).replace(
      "from '@bakery-framework/orm'",
      `from '${entry}'`,
    )

    const path = fs.resolve(
      tmpdir(),
      `bakery-gen-${process.pid}-${Date.now()}.ts`,
    )
    await Bun.write(path, source)
    try {
      // As a file:// URL, for the same reason `entry` above is one. A bare
      // Windows absolute path resolved when this file ran alone and failed
      // inside the full suite with `Cannot find module … from ''` — the
      // importer context differs, and a drive-lettered path is not a specifier.
      // Deterministic, not flaky: 5/5 alone, 3/3 failures in the suite.
      const module = await import(Bun.pathToFileURL(path).href)
      expect(collectConstraints(module)).toEqual({
        widgets: {
          id: { type: 'integer', autoIncrement: true, primary: true },
          // `nullable` on the first two is the round-trip loss noted above,
          // not something this layout introduced.
          label: { type: 'string', default: null, nullable: true },
          note: { type: 'string', default: null, nullable: true },
          qty: { type: 'integer', default: 0, nullable: true },
          madeAt: { type: 'integer', default: '%dateNow%' },
        },
      })
    } finally {
      rmSync(path, { force: true })
    }
  })

  test('file and none layouts are unchanged, and are the default', async () => {
    for (const layout of ['file', 'none', undefined] as const) {
      const source = await generate(layout)
      expect(source).toContain('export namespace DBInfo')
      expect(source).toContain(
        "declare module '@bakery-framework/orm/schema-registry'",
      )
      expect(source).toContain('idxWidgetsLabel')
      expect(source).not.toContain('export const widgets = table(')
    }
  })
})

describe('the previous schema is preserved before it is overwritten', () => {
  const backupDir = `${Bakery.dataDir}/backups`

  async function listSchemaBackups(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(backupDir).catch(() => [] as string[])
    return entries.filter(n => /^schema\.\d+\.ts$/.test(n))
  }

  test('an existing schema is copied aside, not silently destroyed', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE widgets (id INTEGER PRIMARY KEY)').run()

    const schemaPath = `${Bakery.dataDir}/__preserve-test__.ts`
    const original =
      '// hand written, and the only copy — schema.ts is gitignored\n'
    await Bun.write(schemaPath, original)

    const before = await listSchemaBackups()
    await SchemaBuilder.generate(db as any, schemaPath, silentMessages)
    const after = await listSchemaBackups()

    // A *new* file, not a bigger count. `preserveExisting` prunes to ten, so
    // once the directory reaches the cap it adds one and drops one and the
    // count never moves — making a count assertion pass until enough syncs
    // have run, then fail for a reason unrelated to what it tests.
    const added = after.find(name => !before.includes(name))!
    expect({ added: Boolean(added) }).toEqual({ added: true })
    expect(await Bun.file(`${backupDir}/${added}`).text()).toBe(original)

    // And the generated file really did replace it.
    expect(await Bun.file(schemaPath).text()).toContain(
      'export namespace DBInfo',
    )

    await Bun.file(schemaPath).delete()
    await Bun.file(`${backupDir}/${added}`).delete()
  })

  test('nothing is preserved when there is no previous schema', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE widgets (id INTEGER PRIMARY KEY)').run()

    const schemaPath = `${Bakery.dataDir}/__preserve-absent__.ts`
    await Bun.file(schemaPath)
      .delete()
      .catch(() => {})

    const before = await listSchemaBackups()
    await SchemaBuilder.generate(db as any, schemaPath, silentMessages)
    const after = await listSchemaBackups()

    expect(after.length).toBe(before.length)
    await Bun.file(schemaPath).delete()
  })
})

/**
 * What the single-file `DBInfo` layout emits.
 *
 * Both cases below were live bugs found by generating against a real database
 * rather than by the suite — the round-trip test imports the *tables*, so
 * neither the index block nor an extra table it wrote was ever exercised.
 */
describe('the DBInfo layout emits an importable file', () => {
  async function generateFile(): Promise<string> {
    const db = new SQLiteAdapter(':memory:')
    await db
      .query('CREATE TABLE widgets (id INTEGER PRIMARY KEY, slug TEXT)')
      .run()
    await db.createIndex('widgets_slug_uniq', 'widgets', ['slug'], true)
    await db.createIndex('widgets_slug_idx', 'widgets', ['slug'], false)
    // A ledger, exactly as a synced database has.
    const { writeLedger } = await import('./ledger')
    await writeLedger(db as any, await db.getConstraints(), {})

    const path = `${Bakery.cacheDir}/__gen-dbinfo-test.ts`
    await SchemaBuilder.generate(db as any, path, silentMessages, {}, 'file')
    const source = await Bun.file(path).text()
    await Bun.file(path).delete()
    await db.close()
    return source
  }

  test('indexes use Field.Index / Field.Unique, not the removed helpers', async () => {
    const source = await generateFile()
    expect(source).toContain("Field.Unique('widgets', 'slug')")
    expect(source).toContain("Field.Index('widgets', 'slug')")
    // `index(` / `unique(` were emitted after those exports were deleted, so
    // the generated file referenced two identifiers it did not import.
    expect(source).not.toMatch(/[^.\w]index\(/)
    expect(source).not.toMatch(/[^.\w]unique\(/)
  })

  test('the ledger table is not written into the app schema', async () => {
    // `--choose=db` reads the adapter directly, so it has to strip the ledger
    // itself. Without it sync starts managing `__bakery_schema`, the ledger
    // records itself, and the shape check never matches again.
    const source = await generateFile()
    expect(source).not.toContain('bakerySchema')
    expect(source).not.toContain('__bakery_schema')
    expect(source).toContain('widgets:')
  })

  test('every identifier it references, it imports', async () => {
    const source = await generateFile()
    const imported = new Set(
      [...source.matchAll(/import \{([^}]*)\} from/g)]
        .flatMap(m => m[1]!.split(','))
        .map(s => s.replace(/\btype\b/, '').trim())
        .filter(Boolean),
    )
    // Every `Foo(` call at the head of a property value must be imported.
    for (const [, name] of source.matchAll(/:\s*([A-Za-z_][\w]*)\(/g)) {
      expect({ name, imported: imported.has(name!) }).toEqual({
        name,
        imported: true,
      })
    }
  })
})

/**
 * `orm/views.ts`, generated.
 *
 * A view has no column DDL — `CREATE VIEW x AS SELECT …` declares no types, and
 * `createView(name, sql)` takes nothing else — so each one is emitted as an
 * interface plus a `view()` call, not as column builders. Emitting
 * `Field.Varchar(64)` for a view column would state a width the database
 * neither stores nor enforces.
 */
describe('views are generated into their own module', () => {
  async function generateInto(dir: string) {
    const db = new SQLiteAdapter(':memory:')
    await db
      .query(
        'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, active INTEGER)',
      )
      .run()
    await db
      .query(
        'CREATE VIEW active_users AS SELECT id, name FROM users WHERE active = 1',
      )
      .run()

    const tablesPath = `${dir}/tables.ts`
    await SchemaBuilder.generate(
      db as any,
      tablesPath,
      silentMessages,
      {},
      'folder',
    )
    const tables = await Bun.file(tablesPath).text()
    const viewsFile = Bun.file(`${dir}/views.ts`)
    const views = (await viewsFile.exists()) ? await viewsFile.text() : null
    await Bun.file(tablesPath).delete()
    if (views !== null) await viewsFile.delete()
    await db.close()
    return { tables, views }
  }

  test('the view goes to views.ts, not tables.ts', async () => {
    const { tables, views } = await generateInto(Bakery.cacheDir)
    expect(tables).toContain("table('users'")
    // Emitting it in both files would leave two declarations of one view, and
    // collectConstraints silently keeps whichever was exported last.
    expect(tables).not.toContain('activeUsers')
    expect(views).not.toBeNull()
    // camelCase in the schema, snake_case on the way to SQL — the same
    // convention the table generator uses, so a view reads like a table.
    expect(views).toContain("view<'activeUsers', ActiveUsersView>")
  })

  test('the interface is PascalCase and typed from the columns', async () => {
    const { views } = await generateInto(Bakery.cacheDir)
    expect(views).toContain('export interface ActiveUsersView {')
    expect(views).toContain('id: number')
    expect(views).toContain('name: string')
    // No column builders: a view has no column DDL to describe.
    expect(views).not.toContain('Field.')
  })

  test('it imports exactly what it uses', async () => {
    const { views } = await generateInto(Bakery.cacheDir)
    expect(views).toContain("import { view } from '@bakery-framework/orm'")
    expect(views).not.toContain('table(')
  })

  test('no views means no file', async () => {
    // An empty views.ts plus an `export * from './views'` that resolves to
    // nothing is noise in every project that has none.
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE only_a_table (id INTEGER PRIMARY KEY)').run()
    const tablesPath = `${Bakery.cacheDir}/tables.ts`
    await SchemaBuilder.generate(
      db as any,
      tablesPath,
      silentMessages,
      {},
      'folder',
    )
    expect(await Bun.file(`${Bakery.cacheDir}/views.ts`).exists()).toBe(false)
    await Bun.file(tablesPath).delete()
    await db.close()
  })
  test('an existing views.ts is never overwritten', async () => {
    // The whole reason the interface form exists is that you refine it:
    // introspection can only call a JSON column `unknown`, and that a
    // `json_arrayagg(json_object(...))` column holds `{ id: number }[]` is
    // knowledge only the author has. Regenerating over it would delete exactly
    // that work — so the generator seeds this file once and then leaves it.
    const db = new SQLiteAdapter(':memory:')
    await db
      .query('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
      .run()
    await db
      .query('CREATE VIEW active_users AS SELECT id, name FROM users')
      .run()

    const tablesPath = `${Bakery.cacheDir}/tables.ts`
    const viewsPath = `${Bakery.cacheDir}/views.ts`
    await Bun.file(viewsPath)
      .delete()
      .catch(() => {})

    await SchemaBuilder.generate(
      db as any,
      tablesPath,
      silentMessages,
      {},
      'folder',
    )
    const seeded = await Bun.file(viewsPath).text()
    expect(seeded).toContain('ActiveUsersView')

    // Refine it, exactly as a user would after seeing `unknown`.
    const edited = seeded.replace('name: string', 'name: string & { brand: 1 }')
    await Bun.write(viewsPath, edited)

    await SchemaBuilder.generate(
      db as any,
      tablesPath,
      silentMessages,
      {},
      'folder',
    )
    expect(await Bun.file(viewsPath).text()).toBe(edited)

    await Bun.file(tablesPath).delete()
    await Bun.file(viewsPath).delete()
    await db.close()
  })
})
