import { Field } from '@bakery/orm'
import { posts, users } from './schema'

export const usernameUniq = Field.Unique(users.username)
export const slugUniq = Field.Unique(posts.slug)
export const postsByAuthor = Field.Index(posts.authorId)
export const postsByAuthorDate = Field.Index(posts.authorId, posts.createdAt)
