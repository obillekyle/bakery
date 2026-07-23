import { createElement, Fragment, HTMLBody } from '@server/core'
import { CardHeader, HeroHeader, Layout } from './Layout.tsx'
export default HTMLBody(() => {
  const features = [
    {
      icon: '🚀',
      title: 'Zero Config TSX',
      desc: 'No complex builder configurations. Bun transpiles and runs TSX directly on the server out of the box.',
    },
    {
      icon: '⚡',
      title: 'Route Resolution Caching',
      desc: 'Saves file-lookups for TSX pages/endpoints, serving requests in under 2ms.',
    },
    {
      icon: '🛡️',
      title: 'Priority Routing',
      desc: 'Checks specific files like existing.tsx before matching dynamic routes, preventing pattern conflicts.',
    },
    {
      icon: '🔄',
      title: 'Full LiveReload',
      desc: 'Browser automatically reloads when you modify this TSX file, or any associated CSS, JS, or error templates.',
    },
  ]

  return (
    <Layout title="Server-Side TSX ⚛️ | Bakery">
      <main class="container">
        <HeroHeader
          emoji="⚛️"
          title="TSX Rendering Showcase"
          subtitle="Beautiful, server-rendered components with reactive hot reloading."
        />

        <div class="card-grid">
          <section class="card glass-effect full-width">
            <CardHeader icon="🧠" title="Declarative Server Components" />
            <p class="card-desc">
              This page is written entirely in TSX. All loops, conditional
              components, and data structures are processed on the server and
              delivered as standard, lightweight HTML.
            </p>

            <ul
              class="feature-list"
              style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; list-style: none; padding-left: 0;">
              {features.map(f => (
                <li style="background: rgba(255, 255, 255, 0.02); padding: 1.25rem; border-radius: 0.75rem; border: 1px solid rgba(255, 255, 255, 0.05);">
                  <strong style="display: block; font-size: 1.1rem; margin-bottom: 0.5rem; color: #ffffff;">
                    {f.icon} {f.title}
                  </strong>
                  <span style="font-size: 0.9rem; color: var(--text-muted);">
                    {f.desc}
                  </span>
                </li>
              ))}
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
