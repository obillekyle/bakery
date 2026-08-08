import { view } from '@bakery/orm'
import { posts } from './tables'

/**
 * A view is a stored `SELECT` the database treats as a read-only table.
 *
 * Borrowing `posts`' columns rather than restating them: the shape is the
 * source table's, and a restated column the `SELECT` does not return would only
 * surface at query time.
 */
export const publishedPosts = view(
  'published_posts',
  posts,
  'SELECT * FROM posts WHERE published = 1',
)
