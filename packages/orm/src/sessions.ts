import type {
  SessionListOptions,
  SessionStore,
  StoredSession,
} from '@bakery-framework/core/session'
import type { SQLAdapter } from './adapters/base'
import { getActiveDb } from './connection'

/**
 * Sessions in the app's own database: `sessions.store` in
 * `server.config.ts`.
 *
 * ```ts no-check: a config fragment
 * import { databaseSessions } from '@bakery-framework/orm/sessions'
 *
 * export default {
 *   sessions: { store: databaseSessions(), account: 'accountId' },
 * }
 * ```
 *
 * Nothing is cached between requests, so every `--threads` worker reads the
 * same rows: a session ended in one worker is gone for the next request in
 * all of them. The table is the app's to create, in a migration or a schema
 * declaration (docs/guides/sessions.md has both); this never creates or
 * alters a table, which a database role without DDL rights could not do and
 * migrations mode would not want done behind its back.
 *
 * Every statement runs on the connection in use at the time, so inside
 * `DB.transaction()` it is part of the transaction: deleting an account and
 * `Session.endForAccount()` commit together or not at all.
 */
export interface DatabaseSessionsOptions {
  /** The table the sessions live in. `bakery_sessions` unless named. */
  table?: string
}

export function databaseSessions(
  options: DatabaseSessionsOptions = {},
): SessionStore {
  return new DatabaseSessionStore(options.table ?? 'bakery_sessions')
}

/** The columns an insert writes, in the order `rowValues` gives them. */
const COLUMNS = [
  'id',
  'host',
  'account',
  'data',
  'persisted',
  'created_at',
  'accessed_at',
  'expires_at',
] as const

type Row = {
  id?: unknown
  account: unknown
  data: unknown
  created_at: unknown
  accessed_at: unknown
  expires_at: unknown
}

/**
 * A class rather than a closure over the options: it lives as long as the
 * process, and holds the one string it needs.
 */
class DatabaseSessionStore implements SessionStore {
  constructor(private readonly table: string) {}

  async load(
    host: string,
    id: string,
    now: number,
  ): Promise<StoredSession | undefined> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const row = (await db
      .query(
        `SELECT ${q('account')}, ${q('data')}, ${q('created_at')}, ${q('accessed_at')}, ${q('expires_at')} ` +
          `FROM ${q(this.table)} WHERE ${q('id')} = ? AND ${q('host')} = ? AND ${q('expires_at')} > ?`,
      )
      .get(id, host, now)) as Row | null | undefined
    return row ? decode(id, host, row) : undefined
  }

  async insert(session: StoredSession): Promise<void> {
    const db = getActiveDb()
    const columns = COLUMNS.map(name => db.quote(name)).join(', ')
    await db
      .query(
        `INSERT INTO ${db.quote(this.table)} (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...rowValues(session))
  }

  async update(storedId: string, session: StoredSession): Promise<boolean> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const result = await db
      .query(
        `UPDATE ${q(this.table)} SET ${q('id')} = ?, ${q('account')} = ?, ${q('data')} = ?, ` +
          `${q('persisted')} = ?, ${q('accessed_at')} = ?, ${q('expires_at')} = ? ` +
          `WHERE ${q('id')} = ? AND ${q('host')} = ?`,
      )
      .run(
        session.id,
        session.account,
        encode(session),
        session.persistKeys.length,
        session.accessedAt,
        session.expiresAt,
        storedId,
        session.host,
      )
    return (
      Number(result.changes) > 0 ||
      (await this.stored(db, session.host, session.id))
    )
  }

  async touch(
    host: string,
    id: string,
    accessedAt: number,
    expiresAt: number,
  ): Promise<boolean> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const result = await db
      .query(
        `UPDATE ${q(this.table)} SET ${q('accessed_at')} = ?, ${q('expires_at')} = ? ` +
          `WHERE ${q('id')} = ? AND ${q('host')} = ?`,
      )
      .run(accessedAt, expiresAt, id, host)
    return Number(result.changes) > 0 || (await this.stored(db, host, id))
  }

  async remove(host: string, id: string): Promise<boolean> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const result = await db
      .query(
        `DELETE FROM ${q(this.table)} WHERE ${q('id')} = ? AND ${q('host')} = ?`,
      )
      .run(id, host)
    return Number(result.changes) > 0
  }

  async removeAccount(host: string, account: string): Promise<number> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const result = await db
      .query(
        `DELETE FROM ${q(this.table)} WHERE ${q('account')} = ? AND ${q('host')} = ?`,
      )
      .run(account, host)
    return Number(result.changes)
  }

  async count(now: number): Promise<number> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const row = (await db
      .query(
        `SELECT COUNT(*) AS ${q('total')} FROM ${q(this.table)} WHERE ${q('expires_at')} > ?`,
      )
      .get(now)) as { total: unknown } | null
    return Number(row?.total ?? 0)
  }

  async list(
    host: string,
    options: SessionListOptions,
    now: number,
  ): Promise<{ rows: StoredSession[]; totalRows: number }> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const where = [`${q('host')} = ?`, `${q('expires_at')} > ?`]
    const params: unknown[] = [host, now]

    // Matched without regard to case, against the id and the stored JSON, as
    // the built-in store's listing does; and literally, which that one does
    // not: a search for `50%` there matches every session.
    const needle = options.search?.trim().toLowerCase()
    if (needle) {
      const pattern = `%${db.escapeLike(needle)}%`
      where.push(
        `(LOWER(${q('id')}) LIKE ?${db.likeEscapeClause} OR LOWER(${q('data')}) LIKE ?${db.likeEscapeClause})`,
      )
      params.push(pattern, pattern)
    }
    const filter = where.join(' AND ')

    const counted = (await db
      .query(
        `SELECT COUNT(*) AS ${q('total')} FROM ${q(this.table)} WHERE ${filter}`,
      )
      .get(...params)) as { total: unknown } | null
    const totalRows = Number(counted?.total ?? 0)

    // The same arithmetic as the built-in store's: a page past the end is the
    // last page, and only DESC or ASC reaches the SQL.
    const pageSize = Math.max(1, Math.trunc(options.pageSize))
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
    const page = Math.min(Math.max(1, Math.trunc(options.page)), totalPages)
    const direction = options.sortOrder === 'ASC' ? 'ASC' : 'DESC'
    const sortColumn =
      options.sortBy === 'id'
        ? 'id'
        : options.sortBy === 'keys'
          ? 'persisted'
          : 'accessed_at'

    const rows = (await db
      .query(
        `SELECT ${q('id')}, ${q('account')}, ${q('data')}, ${q('created_at')}, ${q('accessed_at')}, ${q('expires_at')} ` +
          `FROM ${q(this.table)} WHERE ${filter} ` +
          `ORDER BY ${q(sortColumn)} ${direction}, ${q('id')} ${direction} ` +
          `LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      )
      .all(...params)) as Row[]

    return {
      rows: rows.map(row => decode(String(row.id), host, row)),
      totalRows,
    }
  }

  async prune(now: number): Promise<number> {
    const db = getActiveDb()
    const q = (name: string) => db.quote(name)
    const result = await db
      .query(`DELETE FROM ${q(this.table)} WHERE ${q('expires_at')} <= ?`)
      .run(now)
    return Number(result.changes)
  }

  /**
   * Whether a session is stored, asked only after an UPDATE reported no rows.
   *
   * That count cannot answer it alone on MySQL, which reports the rows an
   * UPDATE *changed*, not the rows it matched. Measured against MySQL 8.4 on
   * Bun 1.4.2: an UPDATE writing the values a row already holds reports 0
   * there and 1 on SQLite and Postgres. `Session.save` of an unchanged
   * session, or a renewal in the millisecond of the last write, would
   * otherwise read as a session ended elsewhere.
   */
  private async stored(
    db: SQLAdapter,
    host: string,
    id: string,
  ): Promise<boolean> {
    const q = (name: string) => db.quote(name)
    const row = await db
      .query(
        `SELECT 1 AS ${q('found')} FROM ${q(this.table)} WHERE ${q('id')} = ? AND ${q('host')} = ?`,
      )
      .get(id, host)
    return Boolean(row)
  }
}

/** What the `data` column holds: the session's data and which keys persist. */
function encode(session: StoredSession): string {
  return JSON.stringify({
    data: session.data,
    persistKeys: session.persistKeys,
  })
}

function rowValues(session: StoredSession): unknown[] {
  return [
    session.id,
    session.host,
    session.account,
    encode(session),
    session.persistKeys.length,
    session.createdAt,
    session.accessedAt,
    session.expiresAt,
  ]
}

/**
 * A row as a stored session. `BIGINT` comes back as a string from Postgres
 * and MySQL, and a `data` column declared `json` or `jsonb` comes back
 * already parsed, so both are taken as they come.
 */
function decode(id: string, host: string, row: Row): StoredSession {
  const payload = (
    typeof row.data === 'string' ? JSON.parse(row.data) : row.data
  ) as { data?: unknown; persistKeys?: unknown } | null
  const data = payload?.data
  const persistKeys = payload?.persistKeys
  return {
    id,
    host,
    account: row.account === null ? null : String(row.account),
    createdAt: Number(row.created_at),
    accessedAt: Number(row.accessed_at),
    expiresAt: Number(row.expires_at),
    persistKeys: Array.isArray(persistKeys) ? persistKeys.map(String) : [],
    data:
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  }
}
