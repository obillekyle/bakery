/**
 * Template schema — copy this to `schema.ts` to get started:
 *
 * ```sh
 * cp schema.example.ts schema.ts
 * bun run db:sync
 * ```
 *
 * `schema.ts` itself is gitignored: it belongs to the application, and
 * `db:sync` rewrites it (it can generate the file from an existing database
 * with `--choose=db`). This example is tracked so the shape — and, more
 * importantly, the registration block at the bottom — is discoverable in a
 * fresh clone.
 *
 * The framework never imports this file for types. Everything runs and
 * typechecks without it; the ORM is simply untyped (permissive `any`
 * columns) until a schema registers itself.
 */
import {
  dateNow,
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
  index,
  primary,
  unique,
  value,
} from '@bakery/orm/schema-util'

export namespace DBInfo {
  export const constraints = {
    users: {
      id: primary(),
      username: value('string', null),
      email: value('string', null),
      password: value('string', null),
      createdAt: value('integer', dateNow),
    },
    posts: {
      id: primary(),
      authorId: value('integer', null),
      title: value('string', null),
      slug: value('string', null),
      body: value('string', ''),
      published: value('integer', 0),
      createdAt: value('integer', dateNow),
    },
    comments: {
      id: primary(),
      postId: value('integer', null),
      // Third argument marks the column optional on insert.
      authorId: value('integer', null, true),
      body: value('string', null),
      createdAt: value('integer', dateNow),
    },
  } as const

  export const indexes = {
    usersUsernameUniq: unique('users', ['username']),
    postsSlugUniq: unique('posts', ['slug']),
    postsAuthorIdx: index('posts', ['authorId']),
    commentsPostIdx: index('comments', ['postId']),
  } as const

  type C = typeof constraints
  export type Table<T extends keyof C> = ExtractTableTypes<C, T>
  export type Optionals<T extends keyof C> = ExtractOptionals<C, T>
  export type Views = ExtractViews<C>
}

export type DBSchema = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Table<T>
}

export type DBOptionals = {
  [T in keyof typeof DBInfo.constraints]: DBInfo.Optionals<T>
}

/**
 * Registers this schema with the framework's type system, which is what makes
 * `DB.from('posts')` know its columns. Keep this block — without it the ORM
 * still works, but every table and column is `any`.
 */
declare module '@bakery/orm/schema-registry' {
  interface SchemaRegistry {
    schema: {
      DBSchema: DBSchema
      DBOptionals: DBOptionals
      Views: DBInfo.Views
    }
  }
}
