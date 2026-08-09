import { defineRoute, response } from '@bakery/core'
import DB from '@bakery/orm'

// Declared once, typed everywhere below: body.title / body.slug / body.body
// are strings, while undeclared keys stay reachable (body is RouteBody<P>,
// declared params merged over a permissive base). The body is still client
// input — declaring the shape states the contract, it does not validate it.
export default defineRoute<{ title: string; slug: string; body: string }>(
  async (req, body) => {
    if (req.method === 'POST') {
      await DB.Insert.into('posts')
        .values({
          authorId: 1,
          title: body.title,
          slug: body.slug,
          body: body.body,
        })
        .run()
      return response.json.success('created')
    }

    const posts = await DB.from('posts').selectAll('posts').array()
    return response.json.success('ok', posts)
  },
)
