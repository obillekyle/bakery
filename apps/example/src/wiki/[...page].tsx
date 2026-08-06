import { createElement, Fragment, HTMLBody } from '@bakery/core'
import { CardHeader, HeroHeader, Layout } from '../Layout.tsx'

// A catch-all segment: this one file answers /wiki/<anything>, however deep.
// `body.page` is the joined rest of the path ('guides/routing' for
// /wiki/guides/routing). More specific routes always win — a sibling
// [id].tsx, a child index.tsx, or a deeper catch-all all outrank it — and
// /wiki itself is NOT claimed (a catch-all needs at least one rest segment).
export default HTMLBody<{ page: string }>((req, body) => {
  const crumbs = body.page.split('/')

  return (
    <Layout title={`${crumbs[crumbs.length - 1]} | Wiki`}>
      <main class="container">
        <HeroHeader
          emoji="📚"
          title="Wiki"
          subtitle={
            <Fragment>
              Served by the catch-all route <code>wiki/[...page].tsx</code>
            </Fragment>
          }
        />

        <div class="card-grid">
          <section class="card glass-effect full-width">
            <CardHeader icon="🧭" title="Where you are" />
            <p class="card-desc">
              <strong>Full slug:</strong> <code>{body.page}</code>
            </p>
            <p class="card-desc">
              <strong>Segments:</strong> <code>{crumbs.join(' › ')}</code>
            </p>
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
