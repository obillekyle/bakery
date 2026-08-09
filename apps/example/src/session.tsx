import { HTMLBody } from '@bakery/core'
import { CardHeader, HeroHeader, Layout } from './Layout.tsx'

export default HTMLBody(req => {
  // `req.session` is always present (created lazily on first access). The
  // third `set` argument persists the key, so the counter survives the short
  // default session TTL.
  const session = req.session
  const views = session.get('views', 0) + 1
  session.set('views', views, true)

  // Gather request details
  const headers: [string, string][] = []
  req.headers.forEach((val, key) => {
    headers.push([key, val])
  })

  const ip = req.headers.get('x-forwarded-for') || '127.0.0.1'
  const method = req.method

  return (
    <Layout title="Request & Session Inspector | Bakery">
      <main class="container">
        <HeroHeader
          emoji="🕵️‍♂️"
          title="Request Inspector"
          subtitle="Real-time request metadata and cookie-backed user sessions"
        />

        <div class="card-grid">
          <section class="card glass-effect">
            <CardHeader icon="🍪" title="Cookie Session" />
            <p class="card-desc">
              The server maps session proxies to cookie identifiers, persisting
              data across page visits.
            </p>

            <div style="display: flex; flex-direction: column; gap: 1.25rem;">
              <div style="background: rgba(0,0,0,0.25); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--card-border);">
                <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.25rem;">
                  Session ID
                </div>
                <div style="font-family: var(--font-mono); font-size: 0.85rem; word-break: break-all; color: var(--secondary-accent);">
                  {session.id}
                </div>
              </div>

              <div style="background: rgba(0,0,0,0.25); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--card-border); display: flex; justify-content: space-between; align-items: center;">
                <div>
                  <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase;">
                    Total Page Views
                  </div>
                  <div style="font-size: 1.5rem; font-weight: bold; color: #fff;">
                    {views} visits
                  </div>
                </div>
                <span style="font-size: 2rem;">📈</span>
              </div>

              <div style="background: rgba(0,0,0,0.25); padding: 1rem; border-radius: 0.75rem; border: 1px solid var(--card-border);">
                <div style="font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 0.25rem;">
                  Created/Last Accessed
                </div>
                <div style="font-family: var(--font-mono); font-size: 0.85rem; color: #27c93f;">
                  {new Date(session.createdAt).toLocaleTimeString()}
                </div>
              </div>
            </div>
          </section>

          <section class="card glass-effect" style="grid-column: span 2;">
            <CardHeader icon="🖨️" title="Request Headers" />
            <p class="card-desc">
              HTTP headers received by the Bakery for this request.
            </p>

            <div style="background: rgba(0,0,0,0.2); border-radius: 0.75rem; border: 1px solid var(--card-border); overflow: hidden;">
              <div style="background: rgba(0,0,0,0.4); padding: 0.75rem 1rem; font-family: var(--font-mono); font-size: 0.85rem; border-bottom: 1px solid var(--card-border); display: flex; gap: 1rem; color: var(--text-muted);">
                <span>
                  Method: <strong style="color: #27c93f;">{method}</strong>
                </span>
                <span>
                  IP:{' '}
                  <strong style="color: var(--secondary-accent);">{ip}</strong>
                </span>
              </div>
              <div style="max-height: 250px; overflow-y: auto; padding: 1rem; display: flex; flex-direction: column; gap: 0.75rem; font-family: var(--font-mono); font-size: 0.85rem;">
                {headers.map(([key, val]) => (
                  <div style="display: flex; border-bottom: 1px solid rgba(255,255,255,0.02); padding-bottom: 0.5rem; word-break: break-all;">
                    <span style="color: var(--text-muted); min-width: 150px; display: inline-block;">
                      {key}:
                    </span>
                    <span style="color: #fff;">{val}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>

        <div class="action-group center">
          <a href="/" class="secondary-btn" style="max-width: 250px;">
            Back to Home
          </a>
        </div>
      </main>
    </Layout>
  )
})
