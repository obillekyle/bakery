import { Fragment, HTMLBody, log } from '@bakery/core'
import { CardHeader, HeroHeader, Layout } from '../Layout.tsx'

// The [id] segment from the filename, declared once — body.id is a string
// below instead of `any`. (The filename itself cannot infer this; see
// RouteBody in @bakery/core.)
export default HTMLBody<{ id: string }>((req, body) => {
  const url = new URL(req.url)
  const searchQuery = url.searchParams.toString()

  log({
    msg:
      '%gRendering dynamic TSX page ' +
      JSON.stringify(body) +
      ' with search query: ' +
      searchQuery,
  })

  return (
    <Layout title={`Blog Post ${body.id} | Bakery 🚀`}>
      <main class="container">
        <HeroHeader
          emoji="⚛️"
          title={`Dynamic TSX Post #${body.id}`}
          subtitle={
            <Fragment>
              This page was resolved from file: <code>blog-jsx/[id].tsx</code>
            </Fragment>
          }
        />

        <div class="card-grid">
          <section class="card glass-effect full-width">
            <CardHeader icon="⚡" title="Dynamic Route Resolution" />
            <p class="card-desc">
              The path segment <code>{body.id}</code> was automatically parsed
              and passed down to this TSX component inside the <code>body</code>{' '}
              parameter.
            </p>

            <ul
              class="feature-list"
              style="list-style: none; padding-left: 0; display: flex; flex-direction: column; gap: 1rem;">
              <li style="background: rgba(255, 255, 255, 0.02); padding: 1rem; border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.05);">
                <strong>Resolved ID:</strong> <code>{body.id}</code>
              </li>
              <li style="background: rgba(255, 255, 255, 0.02); padding: 1rem; border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.05);">
                <strong>Query Parameter:</strong>{' '}
                <code>{searchQuery || 'None'}</code> (Pass{' '}
                <code>?searchQuery=something</code> in the URL to see it
                update!)
              </li>
              <li style="background: rgba(255, 255, 255, 0.02); padding: 1rem; border-radius: 0.5rem; border: 1px solid rgba(255, 255, 255, 0.05);">
                <strong>Route Cache:</strong> The routing engine cached this
                path lookup. Next time anyone requests it, it resolves
                instantly!
              </li>
            </ul>

            <div class="action-group center">
              <a href="/" class="primary-btn" style="max-width: 250px;">
                Back to Home
              </a>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  )
})
