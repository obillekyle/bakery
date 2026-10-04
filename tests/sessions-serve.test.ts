import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SQL } from 'bun'
import { type AppServer, bootApp } from './support/serve-app'

/**
 * Sessions in Postgres, asked through a server booted in production with
 * `--threads 2`: an account ended, or its version moved, in one request, and
 * the next request in every worker finding no session.
 *
 * A worker is a thread with its own module state, so nothing short of a real
 * cluster can show that no worker kept a copy: the in-process tests in
 * `packages/orm/src/sessions.test.ts` cannot tell one worker from two.
 * Linux only gets two. Elsewhere `--threads` is clamped to one worker, since
 * the cluster balances connections through SO_REUSEPORT, so on Windows this
 * runs against the one and asks the same questions of it.
 *
 * The app is written to a temporary directory, and imports the framework by
 * file path: the specifiers resolve through this repository's tsconfig, which
 * a directory outside it does not have. The tables are in the shared test
 * database under names `sweep-preload.ts` drops if a killed run leaves them.
 */
const PGSQL_URL = process.env.PGSQL_TEST_URL
const PORT = 4603
const REPO = resolve(import.meta.dir, '..').replaceAll('\\', '/')
const SESSIONS = `bakery_sessions_${process.pid}`
const ACCOUNTS = `bakery_accounts_${process.pid}`
const WORKERS = process.platform === 'linux' ? 2 : 1

/** The guide's table, renamed: the same SQL the store's own tests run. */
const TABLE_SQL = (() => {
  const guide = readFileSync(join(REPO, 'docs/guides/sessions.md'), 'utf8')
  const block = guide.match(/```sql\n(CREATE TABLE bakery_sessions[\s\S]*?)```/)
  if (!block)
    throw new Error('docs/guides/sessions.md gives no bakery_sessions table')
  return block[1]!.replaceAll('bakery_sessions', SESSIONS)
})()

const CONFIG = `import { databaseSessions } from '${REPO}/packages/orm/src/sessions.ts'

export default {
  root: 'src',
  rateLimit: false,
  sessions: {
    store: databaseSessions({ table: '${SESSIONS}' }),
    account: 'accountId',
  },
}
`

const ROUTES: Record<string, string> = {
  'sign-in.ts': `import DB from '${REPO}/packages/orm/src/index.ts'

export default async (req: Request) => {
  const id = Number(new URL(req.url).searchParams.get('account'))
  const account = await DB.from('${ACCOUNTS}').where('id', id).first()
  if (!account) return { signedIn: false }
  req.session.regenerate().set('accountId', id, true).set('version', account.version, true)
  return { signedIn: true, worker: process.env.THREAD_ID ?? '' }
}
`,
  // The check the guide gives: the session's version against the account's.
  'whoami.ts': `import DB from '${REPO}/packages/orm/src/index.ts'
import { Session } from '${REPO}/packages/core/src/session.ts'

export default async (req: Request) => {
  const id = req.session.get('accountId')
  let account = id ?? null
  if (id !== undefined) {
    const row = await DB.from('${ACCOUNTS}').where('id', id).first()
    if (!row || row.version !== req.session.get('version')) {
      req.session.destroy()
      account = null
    }
  }
  return {
    account,
    worker: process.env.THREAD_ID ?? '',
    // One copy of the session module, or the store would be configured in
    // one and asked through another.
    oneModule: req.session instanceof Session,
  }
}
`,
  'end.ts': `import { Session } from '${REPO}/packages/core/src/session.ts'

export default async (req: Request) => {
  const id = Number(new URL(req.url).searchParams.get('account'))
  return { ended: await Session.endForAccount(id) }
}
`,
  'bump.ts': `import { connection } from '${REPO}/packages/orm/src/connection.ts'

export default async (req: Request) => {
  const id = Number(new URL(req.url).searchParams.get('account'))
  await connection.query('UPDATE ${ACCOUNTS} SET version = version + 1 WHERE id = ?').run(id)
  return { bumped: id }
}
`,
}

type WhoAmI = { account: number | null; worker: string; oneModule: boolean }

let dir = ''
let server: AppServer | null = null
let admin: SQL | null = null

describe.skipIf(!PGSQL_URL)('sessions in Postgres, served by a cluster', () => {
  beforeAll(async () => {
    admin = new SQL(PGSQL_URL!)
    await admin.unsafe(`DROP TABLE IF EXISTS ${SESSIONS}, ${ACCOUNTS}`)
    await admin.unsafe(TABLE_SQL)
    await admin.unsafe(
      `CREATE TABLE ${ACCOUNTS} (id INTEGER PRIMARY KEY, version INTEGER NOT NULL)`,
    )
    await admin.unsafe(
      `INSERT INTO ${ACCOUNTS} (id, version) VALUES (7, 1), (8, 1)`,
    )

    dir = mkdtempSync(join(tmpdir(), 'bakery-sessions-'))
    mkdirSync(join(dir, 'src/api'), { recursive: true })
    writeFileSync(join(dir, 'server.config.ts'), CONFIG)
    for (const [name, source] of Object.entries(ROUTES)) {
      writeFileSync(join(dir, 'src/api', name), source)
    }

    server = await bootApp(dir, PORT, {
      args: ['--threads', String(WORKERS)],
      env: { DB_URL: PGSQL_URL! },
    })
  }, 90_000)

  afterAll(async () => {
    server?.stop()
    await admin?.unsafe(`DROP TABLE IF EXISTS ${SESSIONS}, ${ACCOUNTS}`)
    await admin?.close()
    // On Windows the killed server still holds its files for a moment.
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    })
  })

  /**
   * One request on a connection of its own. A kept-alive connection stays
   * with the worker that accepted it, and the kernel only spreads new ones.
   */
  async function ask(path: string, cookie = ''): Promise<Response> {
    return fetch(server!.base + path, {
      headers: { connection: 'close', ...(cookie ? { cookie } : {}) },
      keepalive: false,
    })
  }

  function cookieOf(res: Response): string {
    const value = res.headers.get('set-cookie')?.match(/sId=[^;]+/)?.[0]
    if (!value) throw new Error(`no session cookie from ${res.url}`)
    return value
  }

  /**
   * Ask until every worker has answered, and return every answer: each one
   * must say the same thing, not only the first from each worker.
   */
  async function everyWorker(cookie: string): Promise<WhoAmI[]> {
    const answers: WhoAmI[] = []
    const seen = new Set<string>()
    const deadline = Date.now() + 20_000
    while (seen.size < WORKERS && Date.now() < deadline) {
      const body = (await (await ask('/api/whoami', cookie)).json()) as WhoAmI
      answers.push(body)
      seen.add(body.worker)
    }
    expect(seen.size).toBe(WORKERS)
    return answers
  }

  test('an account ended in one request has no session in any worker on the next', async () => {
    const seven = cookieOf(await ask('/api/sign-in?account=7'))
    const eight = cookieOf(await ask('/api/sign-in?account=8'))

    // Written by whichever worker signed in, read by every one of them.
    for (const answer of await everyWorker(seven)) {
      expect(answer).toMatchObject({ account: 7, oneModule: true })
    }

    const ended = (await (await ask('/api/end?account=7')).json()) as {
      ended: number
    }
    expect(ended.ended).toBe(1)

    for (const answer of await everyWorker(seven)) {
      expect(answer.account).toBeNull()
    }
    const other = (await (await ask('/api/whoami', eight)).json()) as WhoAmI
    expect(other.account).toBe(8)
  }, 60_000)

  test('an account whose version moves has no session in any worker on the next request', async () => {
    const eight = cookieOf(await ask('/api/sign-in?account=8'))
    for (const answer of await everyWorker(eight)) {
      expect(answer.account).toBe(8)
    }

    await ask('/api/bump?account=8')

    for (const answer of await everyWorker(eight)) {
      expect(answer.account).toBeNull()
    }
  }, 60_000)
})
