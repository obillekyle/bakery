import { Field, table } from '@bakery/orm'

export const users = table('users', {
  id: Field.Primary(),
  username: Field.Varchar(64, null),
  email: Field.Varchar(255, null),
  createdAt: Field.Date.now(),
})

export const posts = table('posts', {
  id: Field.Primary(),
  // `Field.Foreign` rather than a bare integer: the reference lives on the
  // column it constrains, and it is always an integer because `Field.Primary()`
  // always is. `onDelete` is where the cascade is declared, not in a migration.
  authorId: Field.Foreign(users.id, { onDelete: 'CASCADE' }),
  title: Field.Varchar(255, null),
  slug: Field.Varchar(255, null),
  // Sized because it carries a default — MySQL refuses a literal DEFAULT on a
  // TEXT column. `Field.Text()` is the unbounded, default-less form.
  body: Field.Varchar(8192, ''),
  published: Field.Int(0),
  createdAt: Field.Date.now(),
})
