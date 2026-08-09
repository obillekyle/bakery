export function renderSessionsPanel() {
  return (
    <div id="panel-sessions" class="panel">
      <div class="session-browser-header glass-effect">
        <div class="actions-row session-browser-title-row">
          <div>
            <h2>Active Evictable Sessions</h2>
            <span class="session-browser-subtitle">
              Search, sort, and page through in-memory session records.
            </span>
          </div>
          <button
            type="button"
            class="btn btn-secondary"
            onclick="loadSessions()">
            <iconify-icon icon="lucide:refresh-cw"></iconify-icon>
            <span>Refresh Sessions</span>
          </button>
        </div>

        <div class="session-browser-controls">
          <input
            id="session-search-input"
            class="search-input session-search-input"
            type="text"
            placeholder="Search by session id or value..."
            oninput="queueSessionSearch()"
          />
          <select
            id="session-sort-by"
            class="filter-select"
            onchange="loadSessions()">
            <option value="accessed">Last Accessed</option>
            <option value="id">Session ID</option>
            <option value="keys">Persisted Keys</option>
          </select>
          <select
            id="session-sort-order"
            class="filter-select"
            onchange="loadSessions()">
            <option value="DESC">Newest First</option>
            <option value="ASC">Oldest First</option>
          </select>
          <select
            id="session-page-size"
            class="filter-select"
            onchange="changeSessionPageSize()">
            <option value="10">10 rows</option>
            <option value="25" selected>
              25 rows
            </option>
            <option value="50">50 rows</option>
            <option value="100">100 rows</option>
            <option value="500">500 rows</option>
          </select>
        </div>

        <div class="session-browser-pagination pagination-bar compact">
          <div class="page-nav">
            <button
              type="button"
              id="session-page-prev"
              class="btn btn-secondary"
              onclick="prevSessionPage()">
              <iconify-icon icon="lucide:chevron-left"></iconify-icon>
              <span>Prev</span>
            </button>
            <span id="session-page-info">Page 1 of 1</span>
            <button
              type="button"
              id="session-page-next"
              class="btn btn-secondary"
              onclick="nextSessionPage()">
              <span>Next</span>
              <iconify-icon icon="lucide:chevron-right"></iconify-icon>
            </button>
          </div>
          <div class="rows-meta">
            <span id="session-rows-meta">0 sessions matching filters</span>
          </div>
        </div>
      </div>
      <div class="session-grid" id="session-container">
        <div class="results-empty">
          <span>Loading active sessions...</span>
        </div>
      </div>
    </div>
  )
}
