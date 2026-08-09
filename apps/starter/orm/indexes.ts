import { Field } from '@bakery-framework/orm'
import { posts, users } from './tables'

export const usernameUniq = Field.Unique(users.username)
export const slugUniq = Field.Unique(posts.slug)
export const postsByAuthor = Field.Index(posts.authorId)
export const postsByAuthorDate = Field.Index(posts.authorId, posts.createdAt)
