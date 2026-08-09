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
    'E %rConfigured schema path not found%*: {path}. %yschema%* in server.config.ts must name a file or an orm/ folder that exists; remove it to auto-detect. Generating one from the database? Create the (empty) file first.',
} as const

const MESSAGES = messageLogger(logger, syncMsgs)

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
Usage: bun run db:sync [--choose=db|ts] [--dry-run] [--force-sync] [--help]

Flags:
  --choose=db     Generate schema.ts from the database (DB wins)
  --choose=ts     Apply schema.ts to the database (TS wins, default)
  --dry-run       Preview planned changes without applying them
  --force-sync    In production, allow destructive changes
  --no-ledger     Diff against live introspection, ignoring the recorded schema
  --help, -h      Show this help message
`)
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

    await connection.syncSchema(
      constraints,
      tsIndexes,
      schemaPath,
      loaded.layout,
    )
    await closeDB()
  }
}

if (import.meta.main) {
  await SyncService.run()
  process.exit(0)
}
