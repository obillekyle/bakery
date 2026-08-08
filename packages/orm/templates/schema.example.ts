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
import { Field } from '@bakery/orm'
import {
  type ExtractOptionals,
  type ExtractTableTypes,
  type ExtractViews,
} from '@bakery/orm/schema-util'

export namespace DBInfo {
  export const constraints = {
    users: {
      id: Field.Primary(),
      // `Varchar` rather than `Text` wherever a length is known: it is the only
      // text form that can carry a default on MySQL, and the width is part of
      // the column diff, so widening one migrates.
      username: Field.Varchar(64, null),
      email: Field.Varchar(255, null),
      password: Field.Varchar(255, null),
      createdAt: Field.Date.now(),
    },
    posts: {
      id: Field.Primary(),
      authorId: Field.Int(null),
      title: Field.Varchar(255, null),
      slug: Field.Varchar(255, null),
      // Sized, not `Text`, because it has a default: MySQL refuses a literal
      // DEFAULT on a TEXT column, so `Field.String('')` here is what previously
      // stopped this template syncing against MySQL at all. Use `Field.Text()`
      // for unbounded text with no default.
      body: Field.Varchar(8192, ''),
      published: Field.Int(0),
      createdAt: Field.Date.now(),
    },
    comments: {
      id: Field.Primary(),
      postId: Field.Int(null),
      authorId: Field.Int(null),
      body: Field.Varchar(8192, ''),
      createdAt: Field.Date.now(),
    },
  } as const

  export const indexes = {
    usersUsernameUniq: Field.Unique('users', ['username']),
    postsSlugUniq: Field.Unique('posts', ['slug']),
    postsAuthorIdx: Field.Index('posts', ['authorId']),
    commentsPostIdx: Field.Index('comments', ['postId']),
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
