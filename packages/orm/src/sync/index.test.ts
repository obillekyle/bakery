import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SyncService } from './index'

/**
 * `db:sync --help` used to be the *last* thing `run()` checked, after
 * `initConfig`, `initDB`, `loadSchema` and both fatal guards. So the one flag
 * whose job is to explain the others could not be reached on a database it
 * could not open or a schema it refused, and asking for help opened a
 * connection and created `bakery/server.db` as a side effect.
 *
 * Driven as a subprocess rather than by calling `run()` here: the ordering is
 * the whole point, and only a real process shows what was touched on the way.
 * It also keeps `core/init.ts` — which `sync/index.ts` imports for its side
 * effects, redefining `process.env` flags process-wide — out of the test runner.
 * Two spawns, reused across the assertions, because each costs a few seconds.
 */
const ENTRY = path.resolve(import.meta.dir, 'index.ts')

/** A `foreign()` declaration: the guard that exits 1 before help was reached. */
const SCHEMA_WITH_FOREIGN = `export const users = {
  __table: 'users',
  __source: 'users',
  __columns: { id: { type: 'integer', primary: true } },
}
export const postAuthor = {
  type: 'foreign',
  table: 'users',
  cols: ['id'],
  refTable: 'users',
  refCols: ['id'],
}
`

describe('--help is answered before anything is opened', () => {
  const cwd = path.join(tmpdir(), `bakery-help-${process.pid}-${Date.now()}`)
  let help: { out: string; exitCode: number }
  let noFlag: { out: string; exitCode: number }
  /** Whether `<cwd>/bakery` existed after each run — sampled between them. */
  let dataAfterHelp = false
  let dataAfterNoFlag = false

  function runSync(...args: string[]) {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', ENTRY, ...args],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // No DB_URL, so the SQLite adapter resolves <cwd>/bakery/server.db — and
      // its constructor creates that directory. Its absence afterwards is the
      // evidence that nothing connected.
      env: { ...process.env, DB_URL: '', DATABASE_URL: '' },
    })
    return {
      out: result.stdout.toString() + result.stderr.toString(),
      exitCode: result.exitCode,
    }
  }

  beforeAll(async () => {
    // Written as plain objects rather than by importing `@bakery/orm`, exactly
    // as `load.test.ts` does: the fixture must not need a resolution path back
    // into the workspace from a temp directory.
    await Bun.write(path.join(cwd, 'schema.ts'), SCHEMA_WITH_FOREIGN)
    help = runSync('--help')
    dataAfterHelp = existsSync(path.join(cwd, 'bakery'))
    noFlag = runSync()
    dataAfterNoFlag = existsSync(path.join(cwd, 'bakery'))
  })

  afterAll(() => rmSync(cwd, { recursive: true, force: true }))

  test('usage is printed and the process exits 0', () => {
    expect(help.out).toContain('Usage: bun run db:sync')
    expect(help.out).toContain('--choose=db')
    expect(help.out).toContain('--force-sync')
    expect(help.exitCode).toBe(0)
  })

  test('the schema guards do not run, so a foreign() cannot suppress help', () => {
    // Previously: exit 1, this message, and no usage text at all.
    expect(help.out).not.toContain('foreign() is declared but not implemented')
  })

  test('no database directory is created', () => {
    expect(dataAfterHelp).toBe(false)
  })

  test('without the flag the schema is loaded and the database is opened', () => {
    // The complement to the assertions above: moving the `--help` check must
    // not have skipped the schema work, only reordered it. The same invocation
    // minus `--help` does open the database.
    //
    // This used to assert `exit 1` and the "foreign() is declared but not
    // implemented" message, because `foreign()` aborted the run. It no longer
    // does — all three adapters emit and read back real foreign keys — so the
    // fixture's `foreign()` now reaches the planner like any other declaration
    // and the run reports a plan instead of refusing.
    expect(noFlag.out).not.toContain('foreign() is declared but not implemented')
    expect(noFlag.out).toContain('db-sync')
    expect(dataAfterNoFlag).toBe(true)
  })
})

describe('the flag itself', () => {
  test('is recognised in either spelling, and only those', () => {
    expect(SyncService.helpRequested(['--help'])).toBe(true)
    expect(SyncService.helpRequested(['--dry-run', '-h'])).toBe(true)
    expect(SyncService.helpRequested(['--dry-run'])).toBe(false)
    expect(SyncService.helpRequested([])).toBe(false)
  })
})
