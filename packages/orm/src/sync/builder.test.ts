import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'bun:test'
import { Bakery } from '@bakery/core/core/bakery'
import { fs } from '@bakery/core/utils'
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
      "declare module '@bakery/orm/schema-registry'",
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
 * namespace *and* added a second `declare module '@bakery/orm/schema-registry'`
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
    // convention is that a null default means nullable. So it falls through to
    // `value()`, which has a separate argument for it — emitting `Field.Int(0)`
    // here would quietly turn a nullable column into NOT NULL.
    expect(source).toContain("qty: value('integer', 0, true),")

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
    expect(source).not.toContain("declare module '@bakery/orm/schema-registry'")
    expect(source).not.toContain('interface SchemaRegistry')
  })

  test('a folder layout leaves indexes to indexes.ts', async () => {
    const source = await generate('folder')
    expect(source).not.toContain('idxWidgetsLabel')
    expect(source).not.toContain('unique(')
  })

  test('the folder module imports exactly the helpers it used', async () => {
    const source = await generate('folder')
    // Exactly the helpers used, sorted: `Field` for the columns it can name,
    // `value` for the one it cannot, and no `dateNow` — `Field.Date.now()` needs
    // no marker import.
    expect(source).toContain("import { Field, table, value } from '@bakery/orm'")
    expect(source).not.toContain('dateNow')
  })

  test('the emitted module really is importable, and round-trips', async () => {
    // Written to a real file and imported: a generated schema that does not
    // parse, or whose `table()` values `collectConstraints` cannot read, is the
    // failure this whole change is about.
    //
    // The `@bakery/orm` specifier is rewritten to this package's own entry
    // because the workspace links `@bakery/orm` into the *apps*, not into
    // `packages/orm` itself, so nothing under a temp directory can resolve it.
    // The specifier as emitted is asserted separately above.
    const entry = Bun.pathToFileURL(
      fs.resolve(import.meta.dir, '../index.ts'),
    ).href
    const source = (await generate('folder')).replace(
      "from '@bakery/orm'",
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
      expect(source).toContain("declare module '@bakery/orm/schema-registry'")
      expect(source).toContain('idxWidgetsLabel')
      expect(source).not.toContain("export const widgets = table(")
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
    const original = '// hand written, and the only copy — schema.ts is gitignored\n'
    await Bun.write(schemaPath, original)

    const before = await listSchemaBackups()
    await SchemaBuilder.generate(db as any, schemaPath, silentMessages)
    const after = await listSchemaBackups()

    expect(after.length).toBeGreaterThan(before.length)

    const added = after.find(name => !before.includes(name))!
    expect(await Bun.file(`${backupDir}/${added}`).text()).toBe(original)

    // And the generated file really did replace it.
    expect(await Bun.file(schemaPath).text()).toContain('export namespace DBInfo')

    await Bun.file(schemaPath).delete()
    await Bun.file(`${backupDir}/${added}`).delete()
  })

  test('nothing is preserved when there is no previous schema', async () => {
    const db = new SQLiteAdapter(':memory:')
    await db.query('CREATE TABLE widgets (id INTEGER PRIMARY KEY)').run()

    const schemaPath = `${Bakery.dataDir}/__preserve-absent__.ts`
    await Bun.file(schemaPath).delete().catch(() => {})

    const before = await listSchemaBackups()
    await SchemaBuilder.generate(db as any, schemaPath, silentMessages)
    const after = await listSchemaBackups()

    expect(after.length).toBe(before.length)
    await Bun.file(schemaPath).delete()
  })
})
