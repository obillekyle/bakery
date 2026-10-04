import { SQL } from 'bun'
import { SQLAdapter } from '../adapters/base'
import { MySQLAdapter } from '../adapters/mysql'
import { PGAdapter } from '../adapters/pgsql'

/**
 * A schema or a database of a test's own on a live server, for tests that
 * create things the shared `bakery_test` database must not keep: a migration
 * ledger, a trigger function, a role's grants.
 *
 * Shared by the migration tests (`migrate/*.test.ts`) rather than copied into
 * each, so the cleanup they depend on has one spelling. `src/tests/` is left
 * out of the published package.
 */

/** See adapters/nested-tx.test.ts: Bun's MySQL driver needs a pending timer. */
export function alive<T>(promise: T | Promise<T>): Promise<T> {
  const timer = setTimeout(() => {}, 30_000)
  return Promise.resolve(promise).finally(() => clearTimeout(timer))
}

/** Room for live tests: generous, since a server can be slow under the full suite. */
export const LIVE_TIMEOUT = 30_000

export type Isolated = {
  adapter: SQLAdapter
  /** The schema's or database's name. */
  name: string
  /** Another connection to the same schema or database. */
  another: () => SQLAdapter
  drop: () => Promise<void>
}

let isolatedCount = 0

/**
 * A name nothing else uses. Digits after `bakery_mig_` only: the shape
 * `sweep-preload.ts` drops when a killed run leaves a schema or a database
 * behind.
 */
export const isolatedName = () => `bakery_mig_${process.pid}${isolatedCount++}`

/**
 * A Postgres schema of its own, with the connection pointed at it. A schema
 * rather than a database: `CREATE DATABASE` copies a template and took
 * seconds under the full suite, long enough to time tests out.
 */
export async function ownSchema(url: string): Promise<Isolated> {
  const name = isolatedName()
  const admin = new SQL(url)
  await alive(admin.unsafe(`CREATE SCHEMA "${name}"`))
  const open = () =>
    new PGAdapter(new SQL(url, { max: 1, connection: { search_path: name } }))
  const adapter = open()
  return {
    adapter,
    name,
    another: open,
    drop: async () => {
      await adapter.close()
      await alive(admin.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`))
      await admin.close()
    },
  }
}

/** A MySQL database of its own, which on MySQL is the same thing as a schema. */
export async function ownDatabase(url: string): Promise<Isolated> {
  const name = isolatedName()
  const admin = new SQL(url)
  await alive(admin.unsafe(`CREATE DATABASE \`${name}\``))
  const open = () =>
    new MySQLAdapter(new SQL(SQLAdapter.withDatabase(url, name)!, { max: 1 }))
  const adapter = open()
  return {
    adapter,
    name,
    another: open,
    drop: async () => {
      await adapter.close()
      await alive(admin.unsafe(`DROP DATABASE IF EXISTS \`${name}\``))
      await admin.close()
    },
  }
}
