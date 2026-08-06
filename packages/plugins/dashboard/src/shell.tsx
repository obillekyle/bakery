import { renderDatabaseBrowser } from './components/DBBrowser'
import { renderLogsPanel } from './components/LogsPanel'
import { renderSessionsPanel } from './components/SessionsPanel'
import { renderStatsPanel } from './components/StatsPanel'
import { renderTopPagesPanel } from './components/TopPagesPanel'

/**
 * Nav items drive the existing client-side `switchTab`, which finds buttons by
 * the `.tab-btn` class and reads the target id out of the onclick attribute.
 * Keeping that contract lets the chrome be replaced without touching the ~3k
 * lines of panel client code.
 */
const NAV = [
  {
    group: 'Observability',
    items: [
      { id: 'stats', label: 'Overview' },
      { id: 'top-pages', label: 'Traffic' },
      { id: 'logs', label: 'Logs' },
    ],
  },
  {
    group: 'Data',
    items: [
      { id: 'database', label: 'Database' },
      { id: 'sessions', label: 'Sessions' },
    ],
  },
]

function NavItem({ id, label }: { id: string; label: string }) {
  return (
    <button
      type="button"
      class={id === 'stats' ? 'tab-btn active' : 'tab-btn'}
      onclick={`switchTab('${id}')`}>
      <span class="nav-dot"></span>
      <span>{label}</span>
    </button>
  )
}

export default function Dashboard() {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <title>Bakery Console</title>
        <link rel="stylesheet" href="/_dashboard/style.css" />
      </head>
      <body>
        <div class="console">
          <aside class="rail" id="rail">
            <div class="rail-brand">
              <div class="rail-mark">B</div>
              <span class="rail-name">Bakery Console</span>
            </div>

            {NAV.map(section => (
              <nav class="rail-group">
                <div class="rail-group-label">{section.group}</div>
                {section.items.map(item => (
                  <NavItem id={item.id} label={item.label} />
                ))}
              </nav>
            ))}

            <div class="rail-foot">
              <span>Bakery</span>
              <span id="rail-version">v3</span>
            </div>
          </aside>

          <header class="bar">
            <div class="crumbs">
              <button
                type="button"
                class="btn rail-toggle"
                onclick="document.getElementById('rail').classList.toggle('open')"
                aria-label="Toggle navigation">
                ☰
              </button>
              <span>Console</span>
              <span class="sep">/</span>
              <strong id="crumb-current">Overview</strong>
            </div>

            <div class="bar-actions">
              <div class="status-indicator" id="server-status-indicator">
                <span class="status-dot" id="server-status-dot"></span>
                <span id="server-status-text">Connecting…</span>
              </div>

              <div class="profile-dropdown-wrapper" id="profile-dropdown-wrapper">
                <button
                  type="button"
                  class="profile-trigger-btn"
                  onclick="toggleProfileDropdown(event)"
                  aria-label="Account menu">
                  <span class="profile-avatar">A</span>
                  <span aria-hidden="true">▾</span>
                </button>

                <div class="profile-menu" id="profile-menu">
                  <div class="profile-header-info">
                    <span class="profile-admin-name">Administrator</span>
                  </div>
                  {/* No sign-out: the console does not own sessions. The host
                      application authenticates, via the authorize predicate. */}
                  <button
                    type="button"
                    onclick="resetAnalytics(); toggleProfileDropdown(event);">
                    <span>Reset analytics</span>
                  </button>
                </div>
              </div>
            </div>
          </header>

          <main>
            {renderStatsPanel()}
            {renderTopPagesPanel()}
            {renderSessionsPanel()}
            {renderDatabaseBrowser()}
            {renderLogsPanel()}
          </main>
        </div>

        <script src="/_dashboard/dashboard.js"></script>
      </body>
    </html>
  )
}
