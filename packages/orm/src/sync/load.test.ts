import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { fs } from '@bakery/core/utils'
import {
  findUnsupportedForeignKeys,
  loadSchema,
  schemaFromConfig,
} from './load'

/**
 * `foreign()` produced an index named after the constraint, which the next
 * diff compared as `foreign` against `index` and tried to drop and re-add —
 * and since index drops are destructive, the dev server stopped booting.
 *
 * It now fails at load with a message naming the declaration. These pin that
 * it is detected, and that ordinary constraints are not caught by mistake.
 */
describe('unsupported foreign keys are rejected, not silently indexed', () => {
  test('reports every foreign declaration by name', () => {
    const found = findUnsupportedForeignKeys({
      postAuthor: { type: 'foreign', table: 'posts', cols: ['authorId'] },
      commentPost: { type: 'foreign', table: 'comments', cols: ['postId'] },
    })
    expect(found.sort()).toEqual(['commentPost', 'postAuthor'])
  })

  test('leaves indexes and uniques alone', () => {
    const found = findUnsupportedForeignKeys({
      byAuthor: { type: 'index', table: 'posts', cols: ['authorId'] },
      slugUniq: { type: 'unique', table: 'posts', cols: ['slug'] },
    })
    expect(found).toEqual([])
  })

  test('an empty schema reports nothing', () => {
    expect(findUnsupportedForeignKeys({})).toEqual([])
  })
})

/**
 * Fixtures are real files because `loadSchema` really imports them — the whole
 * point of the two-layout probe is which path it reaches for on disk, and a
 * stub of the filesystem would test the stub.
 *
 * They live under `.cache/` (gitignored, already the convention in
 * `$mounts.test.ts`) and each test gets its own directory, so a fixture that
 * exists only to be *ignored* — the decoys below — cannot leak into another
 * case. Tables are written as the plain object shape `table()` produces rather
 * than by importing it, which keeps the fixture free of a resolution path back
 * into the workspace.
 */
const FIXTURES = fs.resolve(process.cwd(), '.cache/__schema-load-test__')

/** `table('name', { … })`'s runtime shape, which is all `load.ts` reads. */
function tableSource(name: string, column: string) {
  return `export const ${name} = {
  __table: '${name}',
  __source: '${name}',
  __columns: { ${column}: { type: 'integer', primary: true } },
}
`
}

const INDEX_SOURCE = `export const byName = {
  type: 'index',
  table: 'folderTable',
  cols: ['name'],
}
`

/** A cwd holding both defaults, so "which one wins" is observable. */
const BOTH = `${FIXTURES}/both`
/** A cwd holding only the single-file default. */
const FILE_ONLY = `${FIXTURES}/file-only`
/** A cwd holding neither. */
const BARE = `${FIXTURES}/bare`
/** A cwd holding both defaults *and* a schema somewhere else entirely. */
const CONFIGURED = `${FIXTURES}/configured`

beforeAll(async () => {
  // index.ts re-exports the hand-authored files, which is how the folder
  // layout presents tables and indexes as one module.
  await Bun.write(
    `${BOTH}/orm/index.ts`,
    `${tableSource('folderTable', 'id')}export * from './indexes'\n`,
  )
  await Bun.write(`${BOTH}/orm/indexes.ts`, INDEX_SOURCE)
  await Bun.write(`${BOTH}/schema.ts`, tableSource('rootTable', 'id'))

  await Bun.write(`${FILE_ONLY}/schema.ts`, tableSource('rootTable', 'id'))

  await Bun.write(`${BARE}/.keep`, '')

  // Decoys: both defaults are present, so any test below that finds them has
  // fallen back instead of honouring the configured path.
  await Bun.write(
    `${CONFIGURED}/orm/index.ts`,
    tableSource('decoyFolder', 'id'),
  )
  await Bun.write(`${CONFIGURED}/schema.ts`, tableSource('decoyRoot', 'id'))
  await Bun.write(`${CONFIGURED}/db/model.ts`, tableSource('configured', 'id'))
  await Bun.write(`${CONFIGURED}/db/orm/index.ts`, tableSource('nested', 'id'))
  await Bun.write(`${CONFIGURED}/empty/.keep`, '')
})

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
})

describe('the default layouts are unchanged', () => {
  test('an orm/ folder wins over a root schema.ts', async () => {
    const loaded = await loadSchema(BOTH)

    expect(loaded.layout).toBe('folder')
    expect(Object.keys(loaded.constraints)).toEqual(['folderTable'])
    // The generator writes tables beside index.ts, never over it.
    expect(loaded.targetPath).toBe(`${BOTH}/orm/tables.ts`)
    expect(loaded.indexes).toHaveProperty('byName')
    expect(loaded.missing).toBeUndefined()
  })

  test('a lone schema.ts still loads', async () => {
    const loaded = await loadSchema(FILE_ONLY)

    expect(loaded.layout).toBe('file')
    expect(Object.keys(loaded.constraints)).toEqual(['rootTable'])
    expect(loaded.targetPath).toBe(`${FILE_ONLY}/schema.ts`)
  })

  test('neither present is not an error', async () => {
    const loaded = await loadSchema(BARE)

    expect(loaded.layout).toBe('none')
    expect(loaded.constraints).toEqual({})
    expect(loaded.targetPath).toBe(`${BARE}/schema.ts`)
    expect(loaded.missing).toBeUndefined()
  })
})

describe('a configured schema path replaces the probe', () => {
  test('a relative file resolves against the app cwd and beats both defaults', async () => {
    const loaded = await loadSchema(CONFIGURED, 'db/model.ts')

    expect(loaded.layout).toBe('file')
    expect(Object.keys(loaded.constraints)).toEqual(['configured'])
    expect(loaded.targetPath).toBe(`${CONFIGURED}/db/model.ts`)
  })

  test('an absolute path is taken as given', async () => {
    const loaded = await loadSchema(CONFIGURED, `${CONFIGURED}/db/model.ts`)

    expect(Object.keys(loaded.constraints)).toEqual(['configured'])
    expect(loaded.targetPath).toBe(`${CONFIGURED}/db/model.ts`)
  })

  test('a directory is the folder layout, written back to tables.ts inside it', async () => {
    const loaded = await loadSchema(CONFIGURED, 'db/orm')

    expect(loaded.layout).toBe('folder')
    expect(Object.keys(loaded.constraints)).toEqual(['nested'])
    expect(loaded.targetPath).toBe(`${CONFIGURED}/db/orm/tables.ts`)
  })

  test('naming the folder entry file is the same thing, and never the write target', async () => {
    const loaded = await loadSchema(CONFIGURED, 'db/orm/index.ts')

    expect(loaded.layout).toBe('folder')
    expect(Object.keys(loaded.constraints)).toEqual(['nested'])
    // index.ts re-exports hand-authored indexes/foreign; --choose=db must not
    // overwrite it.
    expect(loaded.targetPath).toBe(`${CONFIGURED}/db/orm/tables.ts`)
  })

  test('an empty configured value auto-detects, exactly as if unset', async () => {
    const loaded = await loadSchema(CONFIGURED, '')

    expect(loaded.layout).toBe('folder')
    expect(Object.keys(loaded.constraints)).toEqual(['decoyFolder'])
  })
})

/**
 * The guard fails closed. Falling back to the defaults here would mean a typo
 * in one config string leaves the app running with a schema it never chose —
 * and `--choose=db` then writes a freshly generated one to the typo'd path.
 */
describe('a configured path that does not exist fails closed', () => {
  test('a missing file reports the resolved path and loads nothing', async () => {
    const loaded = await loadSchema(CONFIGURED, 'db/mdoel.ts')

    expect(loaded.missing).toBe(`${CONFIGURED}/db/mdoel.ts`)
    expect(loaded.layout).toBe('none')
    // Not the decoys: the defaults were right there and were not used.
    expect(loaded.constraints).toEqual({})
    expect(loaded.indexes).toEqual({})
  })

  test('a folder without an index.ts names the entry it wanted', async () => {
    const loaded = await loadSchema(CONFIGURED, 'empty')

    expect(loaded.missing).toBe(`${CONFIGURED}/empty/index.ts`)
    expect(loaded.constraints).toEqual({})
  })

  test('a path outside the project is reported, not searched for', async () => {
    const loaded = await loadSchema(CONFIGURED, '../nowhere/schema.ts')

    expect(loaded.missing).toBe(fs.resolve(CONFIGURED, '../nowhere/schema.ts'))
    expect(loaded.constraints).toEqual({})
  })
})

describe('reading the option off the app config', () => {
  test('a set path comes back trimmed', () => {
    expect(schemaFromConfig({ schema: '  db/model.ts  ' })).toBe('db/model.ts')
  })

  test('unset, blank and non-string values all mean auto-detect', () => {
    expect(schemaFromConfig({})).toBeUndefined()
    expect(schemaFromConfig({ schema: '' })).toBeUndefined()
    expect(schemaFromConfig({ schema: '   ' })).toBeUndefined()
    expect(schemaFromConfig({ schema: 42 })).toBeUndefined()
    expect(schemaFromConfig(undefined)).toBeUndefined()
    expect(schemaFromConfig(null)).toBeUndefined()
  })
})

/**
 * `orm/tables.ts` was called `orm/schema.ts`.
 *
 * Loading never cared — that goes through `index.ts`'s re-exports, so the
 * filename is free — but *generation* writes to this path. Writing `tables.ts`
 * beside someone's existing `schema.ts` would leave two files declaring the
 * same tables, and `collectConstraints` would silently keep whichever the
 * module exported last.
 */
describe('the folder write target honours the old filename', () => {
  const LEGACY = `${FIXTURES}/legacy`
  const FRESH = `${FIXTURES}/fresh`
  const BOTH_NAMES = `${FIXTURES}/bothnames`

  beforeAll(async () => {
    // A project that predates the rename: index.ts + schema.ts, no tables.ts.
    await Bun.write(`${LEGACY}/orm/index.ts`, tableSource('legacyTable', 'id'))
    await Bun.write(`${LEGACY}/orm/schema.ts`, tableSource('legacyTable', 'id'))
    // A project with neither: the generator should create the new name.
    await Bun.write(`${FRESH}/orm/index.ts`, tableSource('freshTable', 'id'))
    // Both present: the new name wins, so a half-migrated project converges.
    await Bun.write(
      `${BOTH_NAMES}/orm/index.ts`,
      tableSource('bothTable', 'id'),
    )
    await Bun.write(
      `${BOTH_NAMES}/orm/schema.ts`,
      tableSource('bothTable', 'id'),
    )
    await Bun.write(
      `${BOTH_NAMES}/orm/tables.ts`,
      tableSource('bothTable', 'id'),
    )
  })

  test('an existing schema.ts stays the write target', async () => {
    const loaded = await loadSchema(LEGACY)
    expect(loaded.targetPath).toBe(`${LEGACY}/orm/schema.ts`)
  })

  test('a folder with neither gets the new name', async () => {
    const loaded = await loadSchema(FRESH)
    expect(loaded.targetPath).toBe(`${FRESH}/orm/tables.ts`)
  })

  test('when both exist the new name wins', async () => {
    const loaded = await loadSchema(BOTH_NAMES)
    expect(loaded.targetPath).toBe(`${BOTH_NAMES}/orm/tables.ts`)
  })
})
