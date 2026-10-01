import { afterAll, describe, expect, test } from 'bun:test'
import { setLogCallback } from '@bakery-framework/core/logger'
import { SyncService } from '../sync'
import { SQLAdapter } from './base'
import { DatabaseMissingError, isMissingDatabase } from './missing-database'
import { MySQLAdapter } from './mysql'
import { PGAdapter } from './pgsql'

/**
 * A `DB_URL` naming a database the server does not have.
 *
 * A query says so in words that lead somewhere (the database, the server,
 * the command that creates it), and `db:sync` creates it when asked, through
 * the server's maintenance database. The codes recognized are the servers'
 * own, measured: Postgres SQLSTATE 3D000 and MySQL error 1049.
 *
 * Set MYSQL_TEST_URL / PGSQL_TEST_URL to run the live half.
 */

describe('recognizing a missing database', () => {
  test('by the codes each server sends, as each client reports them', () => {
    expect(isMissingDatabase({ errno: '3D000' })).toBe(true) // Bun, Postgres
    expect(isMissingDatabase({ code: '3D000' })).toBe(true) // postgres.js
    expect(isMissingDatabase({ errno: 1049 })).toBe(true) // Bun and mysql2, MySQL
  })

  test('and nothing else', () => {
    for (const other of [
      { errno: '42P01' }, // Postgres: no such table
      { errno: 1146 }, // MySQL: no such table
      { code: 'ER_NO_SUCH_TABLE' },
      new Error('database "x" does not exist'),
      null,
      undefined,
    ]) {
      expect(isMissingDatabase(other)).toBe(false)
    }
  })
})

describe('what the error says, and where creation would run', () => {
  const pg = new PGAdapter('postgres://app:s3cret@db.internal:5432/silid?sslmode=require')
  const my = new MySQLAdapter('mysql://root:s3cret@127.0.0.1:3306/silid?sslmode=require')
  afterAll(async () => {
    await pg.close()
    await my.close()
  })

  test('the database, the server and the command, and never the password', () => {
    const error = (pg as any).explainError({ errno: '3D000' })
    expect(error).toBeInstanceOf(DatabaseMissingError)
    expect(error.database).toBe('silid')
    expect(error.server).toBe('db.internal:5432')
    expect(error.message).toContain('bun run db:sync --create-database')
    expect(error.message).not.toContain('s3cret')
    expect(error.cause).toEqual({ errno: '3D000' })
  })

  test('any other error passes through untouched', () => {
    const other = { errno: '42P01' }
    expect((pg as any).explainError(other)).toBe(other)
  })

  test('a percent-encoded name is named as the server knows it', () => {
    const spaced = new PGAdapter('postgres://app:pw@db.internal:5432/my%20db')
    expect((spaced as any).explainError({ errno: '3D000' }).database).toBe('my db')
    void spaced.close()
  })

  test('creation runs on the maintenance database, keeping credentials and sslmode', () => {
    expect((pg as any).maintenanceUrl()).toBe(
      'postgres://app:s3cret@db.internal:5432/postgres?sslmode=require',
    )
    expect((my as any).maintenanceUrl()).toBe(
      'mysql://root:s3cret@127.0.0.1:3306/mysql?sslmode=require',
    )
  })
})

const LIVE = [
  {
    label: 'Postgres',
    url: process.env.PGSQL_TEST_URL,
    open: (url: string): SQLAdapter => new PGAdapter(url),
    maintenance: 'postgres',
  },
  {
    label: 'MySQL',
    url: process.env.MYSQL_TEST_URL,
    open: (url: string): SQLAdapter => new MySQLAdapter(url),
    maintenance: 'mysql',
  },
]

for (const { label, url, open, maintenance } of LIVE) {
  describe.skipIf(!url)(`${label}: a database that does not exist`, () => {
    // Matched by the sweep in tests/sweep-preload.ts, should a run die
    // before afterAll drops it.
    const name = `bakery_newdb_${process.pid}`
    const target = SQLAdapter.withDatabase(url, name)!
    const opened: SQLAdapter[] = []
    const connect = () => {
      const db = open(target)
      opened.push(db)
      return db
    }

    afterAll(async () => {
      for (const db of opened) await db.close()
      const admin = open(SQLAdapter.withDatabase(url, maintenance)!)
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.quote(name)}`).run()
      } finally {
        await admin.close()
      }
    })

    test('a query names it, instead of the driver error', async () => {
      const error = await connect()
        .query('SELECT 1')
        .get()
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(DatabaseMissingError)
      expect((error as DatabaseMissingError).database).toBe(name)
    })

    test('without the flag and without a terminal, sync refuses and says how', async () => {
      const said: string[] = []
      setLogCallback(entry => void said.push(entry.msg))
      try {
        const outcome = await SyncService.ensureDatabase(connect(), {
          argv: [],
          interactive: false,
        })
        expect(outcome).toBe('missing')
      } finally {
        setLogCallback(() => {})
      }
      expect(said.join('\n')).toContain('--create-database')
    })

    test('--create-database creates it, and the same connection then works', async () => {
      const db = connect()
      const created = await SyncService.ensureDatabase(db, {
        argv: ['--create-database'],
        interactive: false,
      })
      expect(created).toBe('created')
      expect(await db.query('SELECT 1 AS one').get()).toEqual({ one: 1 })
      expect(await SyncService.ensureDatabase(db, { argv: [], interactive: false })).toBe(
        'present',
      )
    })
  })
}
