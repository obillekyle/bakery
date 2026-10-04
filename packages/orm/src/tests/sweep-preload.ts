/**
 * Drop `bakery_*` fixtures a killed run left on the shared servers, once,
 * before any test file loads.
 *
 * Wired as `bun test --preload` rather than into a `beforeAll`, because there
 * is no shared setup to hang it on: the eight live test files construct their
 * adapters inline, at 31 separate sites. A preload is one wiring point and it
 * is guaranteed to run first, which is the property that matters: the damage
 * has to be repaired *before* anything reads the catalog.
 *
 * Silent when there is nothing to do, which is almost always. It prints only
 * when it actually dropped something, because that is a fact about a previous
 * run that somebody should see rather than a status line nobody reads.
 *
 * Never fails the suite. A server that is down is the ordinary state here ( * they are portable binaries that nothing starts at boot), and the live tests
 * already report as skipped in that case. Turning "Postgres is not running"
 * into a suite error would be a worse trade than leaving a sweep undone.
 */
import { SQL } from 'bun'

const TARGETS: { url: string | undefined; driver: 'mysql' | 'pgsql' }[] = [
  { url: process.env.MYSQL_TEST_URL, driver: 'mysql' },
  { url: process.env.PGSQL_TEST_URL, driver: 'pgsql' },
]

const FIXTURE = /^bakery_[a-z0-9]+_\d+$/i

for (const { url, driver } of TARGETS) {
  if (!url) continue

  try {
    const db = new SQL(url)
    const rows =
      driver === 'pgsql'
        ? ((await db`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()`) as {
            name: string
          }[])
        : ((await db`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()`) as {
            name: string
          }[])

    const leaked = rows.map(r => r.name).filter(name => FIXTURE.test(name))
    if (leaked.length) {
      const quote = driver === 'mysql' ? '`' : '"'
      // `CASCADE` on Postgres: a leaked table can carry a leaked view, or a
      // foreign key from another leaked table, and the order the catalog
      // returns them in is not an order they can be dropped in.
      const cascade = driver === 'pgsql' ? ' CASCADE' : ''
      for (const name of leaked) {
        await db.unsafe(
          `DROP TABLE IF EXISTS ${quote}${name}${quote}${cascade}`,
        )
      }
      // Not the structured logger: this is a test preload, and the two
      // documented `console` exceptions are program output of exactly this
      // kind. It is also the only channel a preload has.
      console.log(
        `[sweep] dropped ${leaked.length} leaked ${driver} fixture(s) from a previous run: ${leaked.join(', ')}`,
      )
    }

    // Whole databases, from `adapters/missing-database.test.ts`, which creates
    // one to prove `--create-database` works, and `migrate/runner.test.ts`,
    // which gives each run a database of its own so the migration ledger has
    // nothing to collide with. Both drop theirs in `afterAll`; a run killed in
    // between leaves one behind, and nothing else would ever notice.
    const databases =
      driver === 'pgsql'
        ? ((await db`SELECT datname AS name FROM pg_database`) as { name: string }[])
        : ((await db`SELECT schema_name AS name FROM information_schema.schemata`) as {
            name: string
          }[])
    const leakedDbs = databases
      .map(r => r.name)
      .filter(name => /^bakery_(newdb|mig)_\d+$/.test(name))
    if (leakedDbs.length) {
      const quote = driver === 'mysql' ? '`' : '"'
      for (const name of leakedDbs) {
        await db.unsafe(`DROP DATABASE IF EXISTS ${quote}${name}${quote}`)
      }
      console.log(
        `[sweep] dropped ${leakedDbs.length} leaked ${driver} database(s) from a previous run: ${leakedDbs.join(', ')}`,
      )
    }

    // Postgres schemas, from `migrate/runner.test.ts`, which gives each live
    // test a schema of its own (a database took seconds to create). CASCADE
    // takes the tables, functions and triggers a migration put inside.
    if (driver === 'pgsql') {
      const schemas = (await db`SELECT nspname AS name FROM pg_namespace`) as {
        name: string
      }[]
      const leakedSchemas = schemas
        .map(r => r.name)
        .filter(name => /^bakery_mig_\d+$/.test(name))
      for (const name of leakedSchemas) {
        await db.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
      }
      if (leakedSchemas.length) {
        console.log(
          `[sweep] dropped ${leakedSchemas.length} leaked pgsql schema(s) from a previous run: ${leakedSchemas.join(', ')}`,
        )
      }

      // And roles, from the check's restricted-role test. A role belongs to
      // the cluster, not the database, so it outlives every other cleanup.
      // DROP OWNED revokes what it was granted here first, without which
      // DROP ROLE refuses.
      const roles = (await db`SELECT rolname AS name FROM pg_roles`) as {
        name: string
      }[]
      const leakedRoles = roles
        .map(r => r.name)
        .filter(name => /^bakery_mig_\d+$/.test(name))
      for (const name of leakedRoles) {
        await db.unsafe(`DROP OWNED BY "${name}"`)
        await db.unsafe(`DROP ROLE IF EXISTS "${name}"`)
      }
      if (leakedRoles.length) {
        console.log(
          `[sweep] dropped ${leakedRoles.length} leaked pgsql role(s) from a previous run: ${leakedRoles.join(', ')}`,
        )
      }
    }
    await db.close()
  } catch {
    // See the header: a server that is down is ordinary here, and the live
    // tests already report as skipped. A sweep that cannot connect has nothing
    // to repair and must not be the thing that fails the run.
  }
}
