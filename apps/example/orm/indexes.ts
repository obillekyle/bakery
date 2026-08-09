import { Field } from '@bakery-framework/orm'
import { comments, posts, users } from './tables'

export const usersUsernameUniq = Field.Unique(users.username)
export const postsSlugUniq = Field.Unique(posts.slug)
export const postsAuthorIdx = Field.Index(posts.authorId)
export const commentsPostIdx = Field.Index(comments.postId)
