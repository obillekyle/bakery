import { Field, table } from '@bakery/orm'

export const users = table('users', {
  id: Field.Primary(),
  username: Field.Varchar(64, null),
  email: Field.Varchar(255, null),
  password: Field.Varchar(255, null),
  createdAt: Field.Date.now(),
})

export const posts = table('posts', {
  id: Field.Primary(),
  // The reference lives on the column it constrains, and is always an integer
  // because `Field.Primary()` always is.
  authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
  title: Field.Varchar(255, null),
  slug: Field.Varchar(255, null),
  // Sized because it carries a default: MySQL refuses a literal DEFAULT on a
  // TEXT column.
  body: Field.Varchar(8192, ''),
  published: Field.Int(0),
  createdAt: Field.Date.now(),
})

export const comments = table('comments', {
  id: Field.Primary(),
  postId: Field.Foreign(posts.id, { onDelete: 'CASCADE' }),
  // Nullable: a comment outlives the account that wrote it.
  authorId: Field.Foreign(users.id, { nullable: true, onDelete: 'SET NULL' }),
  body: Field.Varchar(8192, ''),
  createdAt: Field.Date.now(),
})
