import { describe, expect, test } from 'bun:test'
import { alias, collectConstraints, type InferOptionals, type InferSchema, table } from './define'
import { dateNow, type ExtractOptionals, type ExtractTableTypes, primary, value } from './schema-util'

/**
 * The prototype is only worth building if the derived types are
 * indistinguishable from the hand-written ones — otherwise `DB.table('users')`
 * loses autocomplete and the whole idea costs more than it returns.
 *
 * These are compile-time assertions as much as runtime ones: `Exact` fails to
 * typecheck if the two shapes differ in any property or optionality.
 */

/** Mutually assignable — catches widening a column to `any`, or losing null. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const exact = <T extends true>(_ok: T) => true

// ── the object form ────────────────────────────────────────────────────────
const users = table('users', {
  id: primary(),
  username: value('string', null),
  email: value('string', null, true),
  createdAt: value('integer', dateNow),
})

const posts = table('posts', {
  id: primary(),
  authorId: value('integer', null),
  title: value('string', null),
  body: value('string', ''),
})

const objectModule = { users, posts }

// ── the hand-written form it must reproduce ────────────────────────────────
const constraints = {
  users: {
    id: primary(),
    username: value('string', null),
    email: value('string', null, true),
    createdAt: value('integer', dateNow),
  },
  posts: {
    id: primary(),
    authorId: value('integer', null),
    title: value('string', null),
    body: value('string', ''),
  },
} as const

type HandWritten = {
  [T in keyof typeof constraints]: ExtractTableTypes<typeof constraints, T>
}
type HandWrittenOptionals = {
  [T in keyof typeof constraints]: ExtractOptionals<typeof constraints, T>
}

type Derived = InferSchema<typeof objectModule>
type DerivedOptionals = InferOptionals<typeof objectModule>

describe('derived schema matches the hand-written one', () => {
  test('row types are identical, table for table', () => {
    expect(exact<Exact<Derived['users'], HandWritten['users']>>(true)).toBe(true)
    expect(exact<Exact<Derived['posts'], HandWritten['posts']>>(true)).toBe(true)
  })

  test('the whole schema shape is identical', () => {
    expect(exact<Exact<Derived, HandWritten>>(true)).toBe(true)
  })

  test('insert-optionality is preserved', () => {
    expect(
      exact<Exact<DerivedOptionals, HandWrittenOptionals>>(true),
    ).toBe(true)
  })
})

describe('autocomplete sources survive derivation', () => {
  test('table names remain a literal union', () => {
    // This is what `DB.table('...')` completes from.
    expect(exact<Exact<keyof Derived, 'users' | 'posts'>>(true)).toBe(true)
  })

  test('column names remain a literal union per table', () => {
    expect(
      exact<
        Exact<keyof Derived['users'], 'id' | 'username' | 'email' | 'createdAt'>
      >(true),
    ).toBe(true)
  })

  test('qualified column strings can still be built', () => {
    // The shape ColumnString<S, J> relies on.
    type Qualified = {
      [T in keyof Derived]: `${T & string}.${Extract<keyof Derived[T] & string, string>}`
    }[keyof Derived]

    const sample: Qualified = 'users.username'
    expect(sample).toBe('users.username')
    expect(exact<Exact<Extract<Qualified, 'posts.title'>, 'posts.title'>>(true)).toBe(true)
  })
})

describe('column references carry their table', () => {
  test('a column is a value, not a string', () => {
    expect(users.username).toEqual({ __table: 'users', __column: 'username' })
    expect(posts.authorId).toEqual({ __table: 'posts', __column: 'authorId' })
  })

  test('the reference knows its own table, so joins cannot be ambiguous', () => {
    expect(users.id.__table).toBe('users')
    expect(posts.id.__table).toBe('posts')
  })
})

describe('runtime collection feeds the existing sync engine', () => {
  test('rebuilds the constraints object the diff engine consumes', () => {
    const collected = collectConstraints(objectModule)

    expect(Object.keys(collected).sort()).toEqual(['posts', 'users'])
    expect(collected.users).toBe(users.__columns)
    expect((collected.posts as any).title).toEqual(constraints.posts.title)
  })

  test('ignores non-table exports so a barrel can hold anything', () => {
    const collected = collectConstraints({
      users,
      SOME_CONST: 42,
      helper: () => null,
      nested: { not: 'a table' },
    })

    expect(Object.keys(collected)).toEqual(['users'])
  })
})

describe('aliasing survives the move to values', () => {
  const author = alias(users, 'author')
  const editor = alias(users, 'editor')

  test('columns re-qualify against the alias', () => {
    expect(author.username).toEqual({
      __table: 'author',
      __column: 'username',
    })
    expect(editor.username.__table).toBe('editor')
  })

  test('the real table is remembered, so FROM ... AS can be emitted', () => {
    expect(author.__table).toBe('author')
    expect(author.__source).toBe('users')
  })

  test('the same table can appear twice without collision', () => {
    // The case aliasing exists for: a self-join. With strings both sides are
    // text and nothing checks the alias matches its declaration.
    expect(author.id.__table).not.toBe(editor.id.__table)
    expect(author.__source).toBe(editor.__source)
  })

  test('an alias keeps the full column set and its types', () => {
    expect(Object.keys(author.__columns).sort()).toEqual(
      Object.keys(users.__columns).sort(),
    )
    // Compile-time: the alias carries the same column union as its base.
    expect(
      exact<Exact<keyof typeof author.__columns, keyof typeof users.__columns>>(
        true,
      ),
    ).toBe(true)
  })

  test('aliases are not collected as tables to create', () => {
    // An alias is a query-time view of an existing table; the sync engine must
    // not be told to create a table named "author".
    const collected = collectConstraints({ users, posts, author, editor })
    expect(Object.keys(collected).sort()).toEqual(['posts', 'users'])
  })
})
