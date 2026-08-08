import { beforeAll, describe, expect, test } from 'bun:test'

/**
 * Loaded through a non-literal specifier on purpose: a static import would pull
 * schema.example.ts into the server tsconfig project, which already compiles
 * `schema.ts`. Bun resolves this at runtime; TypeScript leaves it alone.
 */
const EXAMPLE_PATH = '../templates/schema.example.ts'
let DBInfo: {
  constraints: Record<string, Record<string, any>>
  indexes: Record<string, { table: string; type: string }>
}

beforeAll(async () => {
  ;({ DBInfo } = await import(EXAMPLE_PATH))
})

/**
 * `schema.example.ts` is the template users copy to `schema.ts`, but no
 * tsconfig project compiles it: the app project is the only one that could
 * (the server project already loads `schema.ts`, and two registration blocks
 * in one program collide), and it narrows `paths` to `@client/*` so the
 * example's `@database/*` import cannot resolve there.
 *
 * So it is guarded here instead. This catches the failure that actually
 * matters — the template drifting out of sync with the `schema-util` API and
 * only breaking for the next person who copies it.
 */
describe('schema.example.ts stays valid', () => {
  test('imports and exposes a constraints table', () => {
    expect(Object.keys(DBInfo.constraints).length).toBeGreaterThan(0)
    expect(DBInfo.constraints).toHaveProperty('users')
  })

  test('Field.Primary() still produces an auto-increment integer key', () => {
    expect(DBInfo.constraints.users.id).toMatchObject({
      type: 'integer',
      primary: true,
      autoIncrement: true,
    })
  })

  test('Field builders still carry type, default and optionality', () => {
    // A nullable integer is optional on insert.
    expect(DBInfo.constraints.comments.authorId).toMatchObject({
      type: 'integer',
      nullable: true,
    })
    // Sized rather than TEXT because it has a default -- MySQL refuses a
    // literal DEFAULT on TEXT, which is what used to break this template.
    expect(DBInfo.constraints.posts.body).toMatchObject({
      type: 'string',
      default: '',
      length: 8192,
    })
  })

  test('Field.Index/Unique still emit table/type descriptors', () => {
    expect(DBInfo.indexes.postsAuthorIdx).toMatchObject({
      table: 'posts',
      type: 'index',
    })
    expect(DBInfo.indexes.usersUsernameUniq).toMatchObject({
      table: 'users',
      type: 'unique',
    })
  })

  test('every index references a table the schema declares', () => {
    const tables = Object.keys(DBInfo.constraints)
    for (const [name, idx] of Object.entries(DBInfo.indexes)) {
      expect({ name, table: (idx as any).table }).toMatchObject({
        name,
        table: expect.stringMatching(new RegExp(`^(${tables.join('|')})$`)),
      })
    }
  })
})
