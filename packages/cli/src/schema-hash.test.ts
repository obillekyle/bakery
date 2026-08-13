import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeSchemaHash } from './schema-hash'

/**
 * `computeSchemaHash` is the whole input to `classifySchemaSync`: an unchanged
 * hash means the dev boot skips the schema sync entirely. So there are two
 * failure directions — a hash that moves when nothing did (a full sync on every
 * reload) and, the expensive one, a hash that holds still when the schema
 * changed, which boots the app against a stale database and logs nothing.
 *
 * Everything here runs against a temp directory passed as the `base` argument.
 * Nothing calls `process.chdir`.
 */

let root: string
let savedDbUrl: string | undefined
let savedDatabaseUrl: string | undefined

/** A fresh, empty app directory. */
async function app(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  return dir
}

/** `computeSchemaHash`, asserting it did not report indeterminate. */
async function hash(dir: string, configured?: string): Promise<string> {
  const value = await computeSchemaHash(configured, dir)
  expect(value).not.toBeNull()
  return value as string
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bakery-schema-hash-'))
  // Ordinary env vars, not the `import.meta.env` mode flags: nothing installs
  // an accessor on these two, so a direct save/restore is correct and
  // `setModeFlag` is not what they need.
  savedDbUrl = process.env.DB_URL
  savedDatabaseUrl = process.env.DATABASE_URL
  delete process.env.DB_URL
  delete process.env.DATABASE_URL
})

afterAll(async () => {
  if (savedDbUrl === undefined) delete process.env.DB_URL
  else process.env.DB_URL = savedDbUrl
  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedDatabaseUrl
  await rm(root, { recursive: true, force: true })
})

afterEach(() => {
  delete process.env.DB_URL
  delete process.env.DATABASE_URL
})

describe('determinism', () => {
  test('the same tree hashes the same twice', async () => {
    const dir = await app('stable')
    await writeFile(join(dir, 'schema.ts'), 'export const a = 1')

    const first = await hash(dir)
    expect(await hash(dir)).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a content change moves the hash', async () => {
    const dir = await app('content')
    const file = join(dir, 'schema.ts')

    await writeFile(file, 'export const a = 1')
    const before = await hash(dir)
    await writeFile(file, 'export const a = 2')

    expect(await hash(dir)).not.toBe(before)
  })

  test('a rewrite with identical content does not move the hash', async () => {
    // Content, not mtime. Editing a file back to what it was must not force a
    // sync, and a `git checkout` that rewrites every file must not either.
    const dir = await app('touch')
    const file = join(dir, 'schema.ts')

    await writeFile(file, 'export const a = 1')
    const before = await hash(dir)
    await new Promise(resolve => setTimeout(resolve, 10))
    await writeFile(file, 'export const a = 1')

    expect(await hash(dir)).toBe(before)
  })

  test('adding a file to the folder layout moves the hash', async () => {
    const dir = await app('folder-add')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export * from "./tables"')
    await writeFile(join(dir, 'orm/tables.ts'), 'export const t = 1')

    const before = await hash(dir)
    await writeFile(join(dir, 'orm/indexes.ts'), 'export const i = 1')

    expect(await hash(dir)).not.toBe(before)
  })

  test('removing a file from the folder layout moves the hash', async () => {
    const dir = await app('folder-remove')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export * from "./tables"')
    await writeFile(join(dir, 'orm/tables.ts'), 'export const t = 1')
    await writeFile(join(dir, 'orm/indexes.ts'), 'export const i = 1')

    const before = await hash(dir)
    await rm(join(dir, 'orm/indexes.ts'))

    expect(await hash(dir)).not.toBe(before)
  })

  test('a rename moves the hash even with identical content', async () => {
    // The path is hashed alongside the bytes, so two files swapping names is a
    // change. It also means moving the app directory re-syncs once —
    // over-syncing, which is the safe direction to be wrong in.
    const dir = await app('rename')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), '')
    await writeFile(join(dir, 'orm/tables.ts'), 'export const t = 1')

    const before = await hash(dir)
    await rm(join(dir, 'orm/tables.ts'))
    await writeFile(join(dir, 'orm/views.ts'), 'export const t = 1')

    expect(await hash(dir)).not.toBe(before)
  })

  test('content cannot be shifted across a file boundary unnoticed', async () => {
    // What the NUL-delimited path between each file's bytes buys. Without it
    // 'AB' + 'CD' and 'ABC' + 'D' stream identical bytes into the hasher and
    // compare equal, so moving a table declaration from one file to the next
    // would read as no change at all.
    const dir = await app('split')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'AB')
    await writeFile(join(dir, 'orm/tables.ts'), 'CD')
    const before = await hash(dir)

    await writeFile(join(dir, 'orm/index.ts'), 'ABC')
    await writeFile(join(dir, 'orm/tables.ts'), 'D')

    expect(await hash(dir)).not.toBe(before)
  })
})

describe('file ordering', () => {
  /**
   * `Bun.Glob.scan` order is the filesystem's, and on NTFS it is already
   * alphabetical — so no arrangement of files on *this* machine can distinguish
   * "sorted" from "whatever readdir said". Asserting against an independent
   * oracle can: it states the exact digest the implementation must produce for
   * a known tree, and states it for the sorted order specifically.
   */
  const oracle = async (files: string[], dbUrl = '') => {
    const hasher = new Bun.CryptoHasher('sha256')
    hasher.update(dbUrl)
    for (const file of files) {
      hasher.update(`\0${file}\0`)
      hasher.update(await Bun.file(file).text())
    }
    return hasher.digest('hex')
  }

  test('the digest is the sorted file list, not the scan order', async () => {
    const dir = await app('order')
    await mkdir(join(dir, 'orm'))
    // Created out of alphabetical order on purpose.
    await writeFile(join(dir, 'orm/views.ts'), 'V')
    await writeFile(join(dir, 'orm/index.ts'), 'I')
    await writeFile(join(dir, 'orm/tables.ts'), 'T')

    // Native separators: the scanned branch hashes `Bun.Glob`'s absolute
    // output verbatim, which is backslashed on Windows. (The configured-*file*
    // branch pushes an `fs.resolve` result instead, which is always
    // forward-slashed — so the same file hashes differently depending on which
    // branch found it. Harmless, since a hash is only ever compared with the
    // previous hash from the same machine, but it is why this cannot use
    // `fs.resolve` as its oracle.)
    const abs = (name: string) => join(dir, 'orm', name)
    const sorted = [abs('index.ts'), abs('tables.ts'), abs('views.ts')]

    expect(await hash(dir)).toBe(await oracle(sorted))
    // And order is load-bearing to the digest, so the assertion above is a
    // statement about ordering rather than an accident.
    expect(await hash(dir)).not.toBe(await oracle([...sorted].reverse()))
  })
})

describe('the database target', () => {
  test('DB_URL is part of the hash', async () => {
    const dir = await app('db-url')
    await writeFile(join(dir, 'schema.ts'), 'export const a = 1')

    const none = await hash(dir)
    process.env.DB_URL = 'postgres://localhost/one'
    const one = await hash(dir)
    process.env.DB_URL = 'postgres://localhost/two'
    const two = await hash(dir)

    expect(new Set([none, one, two]).size).toBe(3)
  })

  test('DATABASE_URL is the fallback, and DB_URL wins over it', async () => {
    const dir = await app('database-url')
    await writeFile(join(dir, 'schema.ts'), 'export const a = 1')

    process.env.DATABASE_URL = 'postgres://localhost/alt'
    const viaFallback = await hash(dir)

    delete process.env.DATABASE_URL
    process.env.DB_URL = 'postgres://localhost/alt'
    // The same target through either variable hashes the same: what is hashed
    // is the database, not which env var named it.
    expect(await hash(dir)).toBe(viaFallback)

    process.env.DATABASE_URL = 'postgres://localhost/ignored'
    expect(await hash(dir)).toBe(viaFallback)
  })
})

describe('the probe', () => {
  test('no schema at all is a stable value, not null', async () => {
    // An app with no database is a supported state. `null` means
    // indeterminate, and would re-sync on every single reload.
    const dir = await app('empty')
    const value = await hash(dir)
    expect(value).toMatch(/^[0-9a-f]{64}$/)
    expect(await hash(dir)).toBe(value)
  })

  test('orm/index.ts wins over a root schema.ts', async () => {
    // Probe order, matching `loadSchema`. Inverted, the hash would track a file
    // the sync never reads.
    const dir = await app('probe-order')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export const o = 1')
    await writeFile(join(dir, 'schema.ts'), 'export const s = 1')

    const before = await hash(dir)
    await writeFile(join(dir, 'schema.ts'), 'export const s = 999')
    expect(await hash(dir)).toBe(before)

    await writeFile(join(dir, 'orm/index.ts'), 'export const o = 999')
    expect(await hash(dir)).not.toBe(before)
  })

  test('an orm/ folder without index.ts is not the folder layout', async () => {
    // `loadSchema` requires `orm/index.ts` to choose the folder layout, so a
    // stray `orm/` directory must not shadow the root `schema.ts`.
    const dir = await app('orm-no-index')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/notes.ts'), 'export const n = 1')
    await writeFile(join(dir, 'schema.ts'), 'export const s = 1')

    const before = await hash(dir)
    await writeFile(join(dir, 'orm/notes.ts'), 'export const n = 999')
    expect(await hash(dir)).toBe(before)

    await writeFile(join(dir, 'schema.ts'), 'export const s = 999')
    expect(await hash(dir)).not.toBe(before)
  })

  test('a configured directory is scanned', async () => {
    const dir = await app('configured-dir')
    await mkdir(join(dir, 'db'))
    await writeFile(join(dir, 'db/index.ts'), 'export const d = 1')
    await writeFile(join(dir, 'db/tables.ts'), 'export const t = 1')

    const before = await hash(dir, 'db')
    await writeFile(join(dir, 'db/tables.ts'), 'export const t = 999')

    expect(await hash(dir, 'db')).not.toBe(before)
  })

  test('a configured path suppresses the default probe entirely', async () => {
    // Configured is not a hint (see `resolveConfigured`'s docstring), so the
    // defaults must not be mixed in — a hash that also covered `orm/` would
    // re-sync on edits the sync is never going to read.
    const dir = await app('configured-suppresses')
    await mkdir(join(dir, 'db'))
    await writeFile(join(dir, 'db/model.ts'), 'export const d = 1')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export const o = 1')
    await writeFile(join(dir, 'schema.ts'), 'export const s = 1')

    const before = await hash(dir, 'db/model.ts')
    await writeFile(join(dir, 'orm/index.ts'), 'export const o = 999')
    await writeFile(join(dir, 'schema.ts'), 'export const s = 999')

    expect(await hash(dir, 'db/model.ts')).toBe(before)
  })

  test('a configured path that does not exist is indeterminate', async () => {
    // null, not a hash of nothing. `classifySchemaSync` fails closed on null
    // and lets SyncService produce its own SCHEMA_NOT_FOUND; a stable hash here
    // would skip the sync and swallow the typo in silence.
    const dir = await app('configured-missing')
    await writeFile(join(dir, 'schema.ts'), 'export const s = 1')

    expect(await computeSchemaHash('db/nope.ts', dir)).toBeNull()
    expect(await computeSchemaHash('not-a-dir', dir)).toBeNull()
  })

  test('only .ts files in the scanned directory count', async () => {
    const dir = await app('extensions')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export const o = 1')
    await writeFile(join(dir, 'orm/notes.md'), 'hello')
    await writeFile(join(dir, 'orm/data.json'), '{}')

    const before = await hash(dir)
    await writeFile(join(dir, 'orm/notes.md'), 'goodbye')
    await writeFile(join(dir, 'orm/data.json'), '{"a":1}')

    expect(await hash(dir)).toBe(before)
  })
})

describe('known divergences from what the sync actually reads', () => {
  /**
   * The probe here is a *filesystem* probe; `loadSchema`'s is a *module graph*
   * walk out of an entry file. Two cases where they disagree, and in both the
   * hash holds still while the schema changes — `classifySchemaSync` returns
   * 'skip' and the app boots against a stale database with no log line.
   *
   * Pinned rather than fixed: these are reported, not repaired, so that the fix
   * is a deliberate and visible change. Both expectations flip when it lands.
   */

  test('KNOWN BUG: a configured orm/index.ts hashes only that one file', async () => {
    // The sharp one, because it is the documented folder layout addressed by
    // its entry file — `resolveConfigured` explicitly treats a path ending in
    // `index.ts` as the folder, loads the re-exported siblings, and generates
    // back into `tables.ts`. This hashes `index.ts` alone, so every edit to
    // `tables.ts` is invisible to it.
    const dir = await app('configured-index')
    await mkdir(join(dir, 'orm'))
    await writeFile(join(dir, 'orm/index.ts'), 'export * from "./tables"')
    await writeFile(join(dir, 'orm/tables.ts'), 'export const t = 1')

    const before = await hash(dir, 'orm/index.ts')
    await writeFile(join(dir, 'orm/tables.ts'), 'export const t = 999')

    expect(await hash(dir, 'orm/index.ts')).toBe(before)
  })

  test('KNOWN BUG: a subdirectory of the schema folder is not hashed', async () => {
    // `*.ts`, not `**/*.ts`. An `orm/index.ts` that re-exports
    // `./tables/users` is loaded in full by the sync and hashed only down to
    // the top level here.
    const dir = await app('subdir')
    await mkdir(join(dir, 'orm/tables'), { recursive: true })
    await writeFile(join(dir, 'orm/index.ts'), 'export * from "./tables/users"')
    await writeFile(join(dir, 'orm/tables/users.ts'), 'export const u = 1')

    const before = await hash(dir)
    await writeFile(join(dir, 'orm/tables/users.ts'), 'export const u = 999')

    expect(await hash(dir)).toBe(before)
  })
})
