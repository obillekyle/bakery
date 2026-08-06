import { index, unique } from '@bakery/orm'
import { posts, users } from './schema'

export const usernameUniq = unique(users.username)
export const slugUniq = unique(posts.slug)
export const postsByAuthor = index(posts.authorId)
export const postsByAuthorDate = index(posts.authorId, posts.createdAt)
