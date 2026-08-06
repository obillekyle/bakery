import { dateNow, primary, table, value } from '@bakery/orm'

export const users = table('users', {
  id: primary(),
  username: value('string', null),
  email: value('string', null, true),
  createdAt: value('integer', dateNow),
})

export const posts = table('posts', {
  id: primary(),
  authorId: value('integer', null),
  title: value('string', null),
  slug: value('string', null),
  body: value('string', ''),
  published: value('integer', 0),
  createdAt: value('integer', dateNow),
})
