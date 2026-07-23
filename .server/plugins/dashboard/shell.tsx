import { renderDatabaseBrowser } from './components/DBBrowser'
import { renderLogsPanel } from './components/LogsPanel'
import { renderSessionsPanel } from './components/SessionsPanel'
import { renderStatsPanel } from './components/StatsPanel'
import { renderTopPagesPanel } from './components/TopPagesPanel'

export default function Dashboard() {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Bakery Console</title>
        <link rel="stylesheet" href="/_dashboard/style.css" />
        <script src="https://code.iconify.design/iconify-icon/3.0.0/iconify-icon.min.js"></script>
      </head>
      <body>
        <header>
          <div class="brand">
            <iconify-icon icon="lucide:zap" class="logo-emoji"></iconify-icon>
            <h1>Bakery Console</h1>
          </div>
          <div class="header-actions">
            <div class="status-indicator" id="server-status-indicator">
              <span class="status-dot" id="server-status-dot"></span>
              <span id="server-status-text">Online (DEV)</span>
            </div>

            <div class="profile-dropdown-wrapper" id="profile-dropdown-wrapper">
              <button
                type="button"
                class="profile-trigger-btn"
                onclick="toggleProfileDropdown(event)"
                aria-label="User Menu">
                <div class="profile-avatar">A</div>
                <iconify-icon
                  icon="lucide:chevron-down"
                  class="profile-trigger-chevron"></iconify-icon>
              </button>

              <div class="profile-menu" id="profile-menu">
                <div class="profile-header-info">
                  <span class="profile-admin-name">Administrator</span>
                </div>
                <button
                  type="button"
                  onclick="resetAnalytics(); toggleProfileDropdown(event);">
                  <iconify-icon
                    icon="lucide:trash-2"
                    class="profile-menu-reset-icon"></iconify-icon>
                  <span>Reset Analytics</span>
                </button>
                {process.env.DASHPASS ? (
                  <a href="/_dashboard/logout" class="profile-menu-logout-link">
                    <iconify-icon icon="lucide:log-out"></iconify-icon>
                    <span>Logout</span>
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </header>

        <main>
          <div class="tabs">
            <button
              type="button"
              class="tab-btn active"
              onclick="switchTab('stats')">
              <iconify-icon icon="lucide:activity"></iconify-icon>
              <span>System Stats</span>
            </button>
            <button
              type="button"
              class="tab-btn"
              onclick="switchTab('top-pages')">
              <iconify-icon icon="lucide:file-text"></iconify-icon>
              <span>Top Pages</span>
            </button>
            <button
              type="button"
              class="tab-btn"
              onclick="switchTab('sessions')">
              <iconify-icon icon="lucide:key"></iconify-icon>
              <span>Session Manager</span>
            </button>
            <button
              type="button"
              class="tab-btn"
              onclick="switchTab('database')">
              <iconify-icon icon="lucide:database"></iconify-icon>
              <span>Database Browser</span>
            </button>
            <button type="button" class="tab-btn" onclick="switchTab('logs')">
              <iconify-icon icon="lucide:terminal"></iconify-icon>
              <span>Server Logs</span>
            </button>
          </div>

          {renderStatsPanel()}
          {renderTopPagesPanel()}
          {renderSessionsPanel()}
          {renderDatabaseBrowser()}
          {renderLogsPanel()}
        </main>

        <script src="/_dashboard/dashboard.js"></script>
      </body>
    </html>
  )
}
