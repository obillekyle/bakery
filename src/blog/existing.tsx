import { createElement, Fragment, HTMLBody } from '@server/core'
import { CardHeader, HeroHeader, Layout } from '../Layout.tsx'
export default HTMLBody((req: any, body: any) => {
  return (
    <Layout title="Prioritized Route | Bakery 🚀">
      <main class="container">
        <HeroHeader
          emoji="🛡️"
          title="Prioritized TSX Route"
          subtitle={
            <Fragment>
              Requested path was: <code>/blog/existing.html</code>
            </Fragment>
          }
        />

        <div class="card-grid">
          <section class="card glass-effect full-width">
            <CardHeader icon="⚡" title="Route Prioritization Feature" />
            <p class="card-desc">
              Although this page was requested via{' '}
              <code>/blog/existing.html</code>, the router found the existing
              template file <code>blog/existing.tsx</code> and prioritized it
              over the dynamic route match <code>blog/[id].html</code>.
            </p>

            <ul class="feature-list">
              <li>
                <strong>Match Priority:</strong> The server automatically scans
                for matching files with extensions <code>.tsx</code>,{' '}
                <code>.html</code>, <code>.ts</code>, <code>.js</code> before
                falling back to dynamic wildcard routes.
              </li>
              <li>
                <strong>Clean URL support:</strong> Allows serving dynamic
                components directly in place of legacy `.html` requests.
              </li>
            </ul>

            <div class="action-group center">
              <a href="/" class="primary-btn">
                Go Back Home
              </a>
            </div>
          </section>
        </div>
      </main>
    </Layout>
  )
})
