/**
 * A server that has no database by the name the connection asked for.
 *
 * Recognized by the code the server itself sends, which is stable across
 * driver versions in a way no message is. Measured 2026-10-01 against
 * Postgres 16 and MySQL 8.4:
 *
 *     Postgres  SQLSTATE 3D000   Bun: errno "3D000"   postgres.js: code "3D000"
 *     MySQL     error 1049       Bun: errno 1049      mysql2: errno 1049
 *
 * postgres.js and mysql2 are not bakery's drivers. They are listed because
 * silid's copy of this ORM runs on them, and one predicate serves both.
 */
export function isMissingDatabase(error: unknown): boolean {
  const e = error as { errno?: unknown; code?: unknown } | null | undefined
  return e?.errno === '3D000' || e?.code === '3D000' || e?.errno === 1049
}

/**
 * What a query raises when the database `DB_URL` names does not exist, in
 * place of the driver's own error (kept as `cause`).
 *
 * The message names the database, the server (host and port, never the
 * credentials in the URL) and the command that creates it, because the
 * driver's version names only the database, and on a production log that
 * reads as data loss rather than as a typo or a missing step.
 */
export class DatabaseMissingError extends Error {
  override readonly name = 'DatabaseMissingError'

  constructor(
    readonly database: string,
    readonly server: string,
    options?: ErrorOptions,
  ) {
    super(
      `Database "${database}" does not exist on ${server}. ` +
        'Run `bun run db:sync --create-database` to create it, or point DB_URL at one that exists.',
      options,
    )
  }
}
