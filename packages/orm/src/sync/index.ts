import '@bakery-framework/core/core/init'

import { Logger, messageLogger } from '@bakery-framework/core/logger'
import { closeDB, connection, initDB } from '../connection'
import { loadSchema, schemaFromConfig } from './load'

const logger = new Logger('db-sync')

const syncMsgs = {
  INVALID_SCHEMA: 'W %yschema.ts is invalid or corrupt. Treating as new.%*',
  NO_DBINFO: 'W %yDBInfo namespace not found in schema.ts!%*',
  FOREIGN_TARGET:
    'E %rForeign key target is not a primary key or unique%*: {refs}. SQL requires the referenced column to be a PRIMARY KEY or carry a UNIQUE index. MySQL and Postgres refuse the CREATE; SQLite accepts it and then fails every insert with "foreign key mismatch". Add unique() on the target column.',
  FOREIGN_UNSUPPORTED:
    'E %rforeign() is declared but not implemented%*: {names}. No adapter emits FOREIGN KEY DDL, so it would be created as a plain index and then re-diffed on every sync. Use index() on the column and enforce the reference in your application.',
  SCHEMA_NOT_FOUND:
    'E %rConfigured schema path not found%*: {path}. %yschema%* in server.config.ts must name a file or an orm/ folder that exists; remove it to auto-detect. Generating one from the database? Create the (empty) file first, or run %ydb:sync --migrate%*.',
  MIGRATE_SCAFFOLDED: 'I Created %y{dir}%* — the generator owns tables.ts.',
  MIGRATE_RETIRED:
    'I Converted to the orm/ folder. The previous %yschema.ts%* was moved to %y{to}%*, not deleted.',
} as const

const MESSAGES = messageLogger(logger, syncMsgs)

/**
 * `orm/index.ts` — the one file in the folder layout nothing else writes.
 *
 * `tables.ts` belongs to the generator, and `views.ts` / `indexes.ts` are seeded
 * by it. This is the re-export barrel plus the type registration, and without
 * the `declare module` block the ORM runs untyped: every table and column falls
 * back to `any`.
 */
function ormIndexModule(hasViews: boolean, hasIndexes: boolean): string {
  // Conditional, and it has to be: the generator seeds `views.ts` and
  // `indexes.ts` only when the database actually has views or indexes, so an
  // unconditional `export * from './views'` is a module that does not resolve
  // in every project that has neither.
  const viewImport = hasViews ? "import * as views from './views'\n" : ''
  const model = hasViews ? 'typeof tables & typeof views' : 'typeof tables'

  return `import type {
  InferOptionals,
  InferSchema,
  InferViews,
} from '@bakery-framework/orm'
import * as tables from './tables'
${viewImport}
export * from './tables'
${hasViews ? "export * from './views'\n" : ''}${hasIndexes ? "export * from './indexes'\n" : ''}
type Model = ${model}

// Without this block the ORM still runs, untyped: every table and column falls
// back to \`any\`. The framework never imports this file at runtime — schema
// values are loaded by path — so this is purely the type registration.
declare module '@bakery-framework/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: InferSchema<Model>
      DBOptionals: InferOptionals<Model>
      Views: InferViews<Model>
    }
  }
}
`
}

export class SyncService {
  protected constructor() {}

  /**
   * Usage text, and whether `--help` was asked for.
   *
   * Separated from `run()` so the answer is available before anything is
   * opened. It used to be the last check in `run()`, after `initConfig`,
   * `initDB`, `loadSchema` and both fatal guards — so the one flag whose whole
   * job is to explain the others exited 1 on an unreachable database or a
   * single `foreign()` declaration, and creating `bakery/server.db` as a side
   * effect of asking for help.
   */
  static helpRequested(argv: string[] = process.argv.slice(2)): boolean {
    return argv.includes('--help') || argv.includes('-h')
  }

  static printHelp(): void {
    // CLI usage text goes to stdout verbatim — it is program output, not a
    // log line, so it deliberately bypasses the structured logger.
    console.log(`
Usage: bun run db:sync [--migrate] [--choose=db|ts] [--dry-run] [--force-sync] [--help]

Flags:
  --migrate       Adopt an existing database: write the schema from what is
                  already there, creating the orm/ folder if none exists, and
                  record it so the next sync has nothing to do. Changes no
                  tables. Use this once, on a database Bakery did not create.
  --choose=db     Generate schema.ts from the database (DB wins)
  --choose=ts     Apply schema.ts to the database (TS wins, default)
  --dry-run       Preview planned changes without applying them
  --force-sync    In production, allow destructive changes
  --no-ledger     Diff against live introspection, ignoring the recorded schema
  --help, -h      Show this help message
`)
  }

  /** `--migrate`: adopt what is already in the database. */
  static migrateRequested(argv: string[] = process.argv.slice(2)): boolean {
    return argv.includes('--migrate')
  }

  /**
   * Write the three files the generator does *not* own, and return the one it
   * does.
   *
   * Only `index.ts`, and that is the whole point of the restraint.
   *
   * The first version also wrote empty `views.ts` and `indexes.ts` stubs, which
   * *broke adoption* in a way that only an end-to-end run showed: the generator
   * seeds both, but only when the file does not already exist, so the stubs
   * blocked it. The schema then declared no views and no indexes, and the very
   * next `db:sync` planned to drop the view and all three indexes it had just
   * adopted. An adoption path that arms a destructive sync is worse than none.
   *
   * `tables.ts` is not written here either: `SchemaBuilder` owns it outright.
   */
  static async writeOrmIndex(cwd: string): Promise<void> {
    const dir = `${cwd}/orm`
    const indexPath = `${dir}/index.ts`
    if (await Bun.file(indexPath).exists()) return

    await Bun.write(
      indexPath,
      ormIndexModule(
        await Bun.file(`${dir}/views.ts`).exists(),
        await Bun.file(`${dir}/indexes.ts`).exists(),
      ),
    )
    MESSAGES.MIGRATE_SCAFFOLDED({ dir: 'orm/' })
  }

  /**
   * Move the old single-file `schema.ts` out of the way after a conversion.
   *
   * Moved, never deleted: it goes to `bakery/backups/`, beside the copies the
   * generator already keeps there. `loadSchema` prefers `orm/index.ts`, so a
   * leftover `schema.ts` would be *ignored* rather than used — which is the
   * quiet kind of wrong, since it looks like the file still describes the app
   * while nothing reads it.
   */
  static async retireSingleFileSchema(
    cwd: string,
    previous: 'folder' | 'file' | 'none',
  ): Promise<void> {
    if (previous !== 'file') return

    const from = `${cwd}/schema.ts`
    const file = Bun.file(from)
    if (!(await file.exists())) return

    const to = `${cwd}/bakery/backups/schema.pre-migrate.${Date.now()}.ts`
    await Bun.write(to, await file.text())
    await file.delete()
    MESSAGES.MIGRATE_RETIRED({ to: to.slice(cwd.length + 1) })
  }

  static async run() {
    // Before initConfig/initDB/loadSchema: help must not depend on a working
    // connection, a loadable schema, or the absence of a `foreign()`.
    if (SyncService.helpRequested()) return SyncService.printHelp()

    const { initConfig } = await import('@bakery-framework/core/core/config')
    const config = await initConfig()
    await initDB()
    // `schema` in server.config.ts when the app sets one; otherwise prefers an
    // orm/ folder and falls back to a single schema.ts.
    const loaded = await loadSchema(process.cwd(), schemaFromConfig(config))
    const schemaPath = loaded.targetPath
    const constraints = loaded.constraints
    const tsIndexes = loaded.indexes

    // A configured path that does not exist is a config error, not an empty
    // project. Continuing would sync against no schema and then generate a new
    // one at the wrong location — with the app's real model still sitting
    // where the typo missed it.
    if (loaded.missing) {
      MESSAGES.SCHEMA_NOT_FOUND({ path: loaded.missing })
      await closeDB()
      return process.exit(1)
    }

    if (loaded.unreferenceable?.length) {
      MESSAGES.FOREIGN_TARGET({ refs: loaded.unreferenceable.join(', ') })
      await closeDB()
      return process.exit(1)
    }

    // `foreign()` used to abort here, because no adapter emitted FOREIGN KEY
    // DDL and the declaration would have become a plain index — referential
    // integrity in appearance only. All three adapters now emit and read back
    // real foreign keys, so the guard is gone.
    //
    // `findUnsupportedForeignKeys` is kept and still exported *from
    // `sync/load`* — it is what a future adapter without support would use to
    // refuse rather than pretend. It is no longer imported here, which is the
    // distinction: the function has a reason to exist, the dead import did not.

    if (loaded.layout === 'none' && (await Bun.file(schemaPath).exists())) {
      MESSAGES.NO_DBINFO()
    }

    // `--migrate` on a project with no schema at all creates the folder layout
    // rather than a single `schema.ts`. Adoption is exactly the case where the
    // folder earns its keep: the generator owns `tables.ts` and regenerating it
    // cannot touch the views, indexes and registration beside it — which for an
    // adopted database is the difference between re-running the command and
    // hand-restoring what it overwrote.
    // `--migrate` always lands on the folder layout, including from an existing
    // single-file `schema.ts`. It used to convert only from *nothing*, which
    // read as an arbitrary distinction: the reason to prefer the folder is that
    // the generator owns `tables.ts` and cannot touch the views, indexes and
    // registration beside it — and that is worth exactly as much to a project
    // that already has a schema as to one that does not.
    const adopting = SyncService.migrateRequested()
    const layout = adopting ? 'folder' : loaded.layout
    const targetPath = adopting ? `${process.cwd()}/orm/tables.ts` : schemaPath

    await connection.syncSchema(constraints, tsIndexes, targetPath, layout)

    // After generation, not before: `index.ts` re-exports `views.ts` and
    // `indexes.ts`, which the generator writes only when the database has views
    // or indexes to write. Deciding what to import before knowing which files
    // exist is how the first version produced a barrel pointing at nothing.
    if (adopting) {
      await SyncService.writeOrmIndex(process.cwd())
      await SyncService.retireSingleFileSchema(process.cwd(), loaded.layout)
    }

    await closeDB()
  }
}

if (import.meta.main) {
  await SyncService.run()
  process.exit(0)
}
