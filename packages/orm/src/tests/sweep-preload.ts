/**
 * Drop `bakery_*` fixtures a killed run left on the shared servers, once,
 * before any test file loads.
 *
 * Wired as `bun test --preload` rather than into a `beforeAll`, because there
 * is no shared setup to hang it on: the eight live test files construct their
 * adapters inline, at 31 separate sites. A preload is one wiring point and it
 * is guaranteed to run first, which is the property that matters — the damage
 * has to be repaired *before* anything reads the catalogue.
 *
 * Silent when there is nothing to do, which is almost always. It prints only
 * when it actually dropped something, because that is a fact about a previous
 * run that somebody should see rather than a status line nobody reads.
 *
 * Never fails the suite. A server that is down is the ordinary state here —
 * they are portable binaries that nothing starts at boot — and the live tests
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
      // foreign key from another leaked table, and the order the catalogue
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
    await db.close()
  } catch {
    // See the header: a server that is down is ordinary here, and the live
    // tests already report as skipped. A sweep that cannot connect has nothing
    // to repair and must not be the thing that fails the run.
  }
}
