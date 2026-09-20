import { getFrameworkVersion } from '@bakery-framework/core'
import { Bakery } from '@bakery-framework/core/core/bakery'
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
 * Is anything serving `/_db`?
 *
 * Asked of the registry's *declarations*, never by importing db-explorer: a
 * plugin-to-plugin import is a package-graph edge, and
 * `tests/conventions.test.ts` allows exactly one of those (this package →
 * analytics). `Handler.namespace` is the declaration: any handler that owns
 * `/_db` as a surface gets the link, including an application serving its own
 * explorer there.
 *
 * This replaces a behavioral probe that called every handler's
 * `canHandle('/_db')` with a control path to exclude the priority-0 catch-all.
 * The probe worked and its `as any` was the tell: the registry could not say
 * what a handler serves, so the question had to be asked by experiment. Now it
 * can: `list()` is typed `typeof Handler[]`, so this reads with no cast, and
 * a second plugin wanting a console entry declares a namespace rather than
 * copying a probe.
 */
function explorerIsMounted(): boolean {
  return Bakery.handlers.fetch.list().some(h => h.namespace === '/_db')
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
        // way *out* of it when the explorer is mounted: a link, not a tab.
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

/**
 * The rendered shell, and the one fact it depends on.
 *
 * Everything in this document is fixed for the life of the process except
 * whether an explorer is mounted at `/_db`, which decides one nav entry, and
 * the framework version, which cannot change at all. Rendering it again per
 * request produced an identical 11.8 KB string every time.
 *
 * Measured at **0.50 ms per render** with a CPU-bound control flat at 27-30 ms
 * - the backlog recorded 12.6 ms, which is 25 times the figure this actually
 * measures. Small, then, and still pure waste on every console page load.
 *
 * Keyed on the mounted flag rather than held unconditionally, so a registry
 * that changes after the first render is followed rather than remembered
 * wrongly. Two entries at most, which is why a plain pair is enough and
 * convention 6 has nothing to say about it.
 */
let shellCache: { mounted: boolean; html: string } | null = null

/** Test seam (convention 9): one test's shell must not answer for another's. */
export function __resetShellCache(): void {
  shellCache = null
}

export default function Dashboard() {
  const explorerMounted = explorerIsMounted()
  if (shellCache?.mounted === explorerMounted) return shellCache.html

  const NAV = navSections(explorerMounted)

  const html = (
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
                 : nothing filled the id, and the framework was on 1.x when it
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
  ) as unknown as string
  // The same cast `raw()` makes in `core/jsx.ts`: `createElement` is declared
  // to return `string` and actually returns a `SafeHtml`, a String subclass
  // that behaves like one everywhere. Cached as it came rather than through
  // `String()`, so nothing about the value changes by being remembered.

  shellCache = { mounted: explorerMounted, html }
  return html
}
