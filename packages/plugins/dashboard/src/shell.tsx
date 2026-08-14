import { getFrameworkVersion } from '@bakery-framework/core'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { Try } from '@bakery-framework/core/utils/common'
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
/**
 * A path nothing should claim, used as the control below.
 */
const NOT_A_ROUTE = '/__bakery_probe_no_handler_serves_this__'

/**
 * Is anything serving `/_db`?
 *
 * Asked **behaviourally**, never by importing db-explorer: a plugin-to-plugin
 * import is a package-graph edge, and `tests/conventions.test.ts` allows
 * exactly one of those (this package → analytics). It is also the better
 * question — the console wants to know whether that path leads somewhere, not
 * which package put it there, so an application serving its own explorer at
 * `/_db` gets the link too.
 *
 * **The control probe is what makes this work.** `StaticHandler.canHandle()`
 * returns `true` unconditionally — it is the priority-0 fallback and claims
 * every path — so "does some handler claim `/_db`" is always yes. A handler
 * that claims `/_db` *and declines a path nobody serves* is claiming a
 * namespace rather than catching everything.
 *
 * `canHandle` signatures vary across handlers and some read the request, so a
 * throw here means "not the one we are looking for" rather than an error.
 */
function explorerIsMounted(): boolean {
  for (const handler of Bakery.handlers.fetch.list()) {
    const claims = (path: string) =>
      Try.return(() => (handler as any).canHandle?.(path) === true, false)
    if (claims('/_db') && !claims(NOT_A_ROUTE)) return true
  }
  return false
}

interface NavEntry {
  id: string
  label: string
  /** Present when this entry leaves the console rather than switching a tab. */
  href?: string
}

function navSections(explorerMounted: boolean): {
  group: string
  items: NavEntry[]
}[] {
  return [
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
        // The console does not browse the database any more, so Database is a
        // way *out* of it when the explorer is mounted — a link, not a tab.
        // Without it the entry stays a tab showing the panel that explains
        // where the editor went and how to get it back; an entry that silently
        // navigates to a 404 would be worse than either.
        explorerMounted
          ? { id: 'database', label: 'Database', href: '/_db' }
          : { id: 'database', label: 'Database' },
        { id: 'sessions', label: 'Sessions' },
      ],
    },
  ]
}

function NavItem({ id, label, href }: NavEntry) {
  if (href) {
    return (
      <a class="tab-btn" href={href}>
        <span class="nav-dot"></span>
        <span>{label}</span>
        <span class="nav-external" aria-hidden="true">
          ↗
        </span>
      </a>
    )
  }

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
  const explorerMounted = explorerIsMounted()
  const NAV = navSections(explorerMounted)

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
                  <NavItem id={item.id} label={item.label} href={item.href} />
                ))}
              </nav>
            ))}

            <div class="rail-foot">
              <span>Bakery</span>
              {/* Was the literal `v3`, which was never any version of anything
                  — nothing filled the id, and the framework was on 1.x when it
                  was written. `getFrameworkVersion()` reads core's own
                  manifest, which is the number this label claims to be; the
                  app's version is a different question and `BAKERY_VERSION`
                  answers that one despite its name. */}
              <span id="rail-version">v{getFrameworkVersion()}</span>
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

              <div
                class="profile-dropdown-wrapper"
                id="profile-dropdown-wrapper">
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
            {explorerMounted ? null : renderDatabaseBrowser()}
            {renderLogsPanel()}
          </main>
        </div>

        <script src="/_dashboard/dashboard.js"></script>
      </body>
    </html>
  )
}
