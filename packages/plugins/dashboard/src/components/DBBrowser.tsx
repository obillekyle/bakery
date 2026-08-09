import { connection } from '@bakery-framework/orm/connection'

const driverNames = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
}

export function renderDatabaseBrowser() {
  const driverName = driverNames[connection.driver] || 'Database'
  return (
    <div id="panel-database" class="panel">
      <style>{`
        .db-mobile-toggle { display: none; margin-bottom: 1rem; width: 100%; justify-content: space-between; align-items: center; }
        @media (max-width: 900px) {
          .db-mobile-toggle { display: flex; }
          #db-sidebar { display: none; }
          #db-sidebar.mobile-open { display: block; margin-bottom: 1rem; }
        }
      `}</style>
      <div class="db-mobile-toggle">
        <h2 class="db-browser-mobile-title">
          <iconify-icon icon="lucide:database"></iconify-icon>
          Database Explorer
        </h2>
        <button
          type="button"
          class="btn btn-secondary"
          onclick="document.getElementById('db-sidebar').classList.toggle('mobile-open')">
          <iconify-icon icon="lucide:menu"></iconify-icon>
          <span>Tables Menu</span>
        </button>
      </div>
      <div class="db-container">
        {/* Left Sidebar: Discovered Tables & Schema Details */}
        <div id="db-sidebar" class="sidebar glass-effect">
          <div class="sidebar-scroll-container">
            <div class="sidebar-search">
              <input
                type="text"
                id="db-table-search"
                class="search-input"
                placeholder="Search tables..."
                oninput="filterTablesList()"
              />
            </div>
            <div class="sidebar-title">
              <span>DISCOVERED TABLES</span>
              <span id="tables-count">(0)</span>
            </div>
            <ul class="table-list" id="tables-list">
              <li class="results-empty">Scanning schema...</li>
            </ul>
          </div>
        </div>

        {/* Right Content Area: Main Browser and SQL Terminal */}
        <div class="console-container">
          {/* Visual Browser Header (Shown only when a table is selected) */}
          <div id="db-browser-view" class="browser-card glass-effect">
            <div class="browser-header">
              <div class="table-info">
                <h2 id="current-table-title">
                  <iconify-icon icon="lucide:table"></iconify-icon>
                  <span>users</span>
                </h2>
                <span id="table-row-count-badge" class="badge">
                  0 rows
                </span>
              </div>
              <div class="actions-group">
                <button
                  type="button"
                  class="btn btn-primary"
                  onclick="openInsertModal()">
                  <iconify-icon icon="lucide:plus"></iconify-icon>
                  <span>Add Row</span>
                </button>
                <button
                  type="button"
                  class="btn btn-secondary"
                  onclick="openImportModal()">
                  <iconify-icon icon="lucide:file-up"></iconify-icon>
                  <span>Import CSV</span>
                </button>
                <div class="export-dropdown-wrapper">
                  <button
                    type="button"
                    class="btn btn-secondary"
                    onclick="toggleExportMenu()">
                    <iconify-icon icon="lucide:download"></iconify-icon>
                    <span>Export ▾</span>
                  </button>
                  <div id="export-menu" class="export-menu">
                    <button type="button" onclick="exportToCSV()">
                      Export to CSV
                    </button>
                    <button type="button" onclick="exportToJSON()">
                      Export to JSON
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn btn-secondary btn-danger"
                  onclick="truncateCurrentTable()">
                  <iconify-icon icon="lucide:alert-triangle"></iconify-icon>
                  <span>Truncate</span>
                </button>
              </div>
            </div>

            {/* Filter Query Builder Bar */}
            <div class="filter-builder-card glass-effect">
              <div class="filter-builder-row">
                <span class="filter-label">
                  <iconify-icon icon="lucide:filter"></iconify-icon>
                  <span>Filters</span>
                </span>
                <select id="filter-col-select" class="filter-select">
                  <option value="">-- Choose Column --</option>
                </select>
                <select id="filter-op-select" class="filter-select">
                  <option value="like">contains</option>
                  <option value="=">equals</option>
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value="is_null">is null</option>
                  <option value="is_not_null">is not null</option>
                </select>
                <input
                  type="text"
                  id="filter-val-input"
                  class="filter-input"
                  placeholder="Filter value..."
                />
                <button
                  type="button"
                  class="btn btn-secondary"
                  onclick="addActiveFilter()">
                  Apply
                </button>
                <button
                  type="button"
                  class="btn btn-secondary"
                  onclick="clearActiveFilters()">
                  Clear All
                </button>
              </div>
              <div id="active-filters-list" class="active-filters-list">
                {/* Dynamically generated filter chips */}
              </div>
            </div>

            {/* Pagination Controls */}
            <div class="pagination-bar">
              <div class="page-size-selector">
                <span>Show</span>
                <select
                  id="db-page-size"
                  class="filter-select"
                  onchange="changePageSize()">
                  <option value="10">10 rows</option>
                  <option value="25">25 rows</option>
                  <option value="50" selected>
                    50 rows
                  </option>
                  <option value="100">100 rows</option>
                  <option value="500">500 rows</option>
                </select>
              </div>
              <div class="page-nav">
                <button
                  type="button"
                  id="btn-page-prev"
                  class="btn btn-secondary"
                  onclick="prevPage()">
                  <iconify-icon icon="lucide:chevron-left"></iconify-icon>
                  <span>Prev</span>
                </button>
                <span id="db-page-info">Page 1 of 1</span>
                <button
                  type="button"
                  id="btn-page-next"
                  class="btn btn-secondary"
                  onclick="nextPage()">
                  <span>Next</span>
                  <iconify-icon icon="lucide:chevron-right"></iconify-icon>
                </button>
              </div>
              <div class="rows-meta">
                <span id="db-rows-meta">0 rows matching filters</span>
              </div>
            </div>

            {/* Interactive Data Table Grid */}
            <div class="results-card glass-effect">
              <div id="browser-grid-body">
                <div class="results-empty">
                  <span>Loading table data...</span>
                </div>
              </div>
            </div>
          </div>

          {/* SQL Terminal Console */}
          <div class="editor-card glass-effect">
            <div class="sql-terminal-header">
              <h2>{driverName} SQL Terminal</h2>
              <span class="console-mode-badge">Read/Write Mode Enabled</span>
            </div>
            <textarea
              class="sql-textarea"
              id="sql-query"
              placeholder="SELECT * FROM users LIMIT 10;"
            />
            <div class="actions-row">
              <span class="sql-terminal-help">
                Supports SELECT, UPDATE, INSERT, DELETE, and administrative
                statements.
              </span>
              <button
                type="button"
                class="btn sql-terminal-run"
                onclick="runQuery()">
                <iconify-icon icon="lucide:play"></iconify-icon>
                <span>Run SQL Command</span>
              </button>
            </div>
          </div>

          {/* SQL Terminal Output */}
          <div class="results-card glass-effect" id="sql-console-results-card">
            <div class="results-header">
              <span>SQL TERMINAL OUTPUT</span>
              <span id="results-meta"></span>
            </div>
            <div id="results-body">
              <div class="results-empty">
                <span>
                  No SQL query executed yet. Write a query above and click "Run
                  SQL Command".
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Dynamic Insert Modal */}
      <div id="modal-insert" class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <h3>Add New Row</h3>
            <button
              type="button"
              class="modal-close"
              onclick="closeInsertModal()">
              &times;
            </button>
          </div>
          <form id="insert-row-form" onsubmit="submitInsertRow(event)">
            <div id="insert-fields-container" class="modal-fields-container">
              {/* Dynamically generated form fields */}
            </div>
            <div class="modal-actions">
              <button
                type="button"
                class="btn btn-secondary"
                onclick="closeInsertModal()">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary">
                Add Row
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Dynamic Edit Modal */}
      <div id="modal-edit" class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <h3>Edit Row Details</h3>
            <button
              type="button"
              class="modal-close"
              onclick="closeEditModal()">
              &times;
            </button>
          </div>
          <form id="edit-row-form" onsubmit="submitEditRow(event)">
            <input type="hidden" id="edit-row-rowid" />
            <div id="edit-fields-container" class="modal-fields-container">
              {/* Dynamically generated form fields */}
            </div>
            <div class="modal-actions">
              <button
                type="button"
                class="btn btn-secondary"
                onclick="closeEditModal()">
                Cancel
              </button>
              <button type="submit" class="btn btn-primary">
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* CSV Import Modal */}
      <div id="modal-import" class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">
            <h3>
              <iconify-icon icon="lucide:file-up"></iconify-icon>
              <span>Bulk Import CSV Data</span>
            </h3>
            <button
              type="button"
              class="modal-close"
              onclick="closeImportModal()">
              &times;
            </button>
          </div>
          <div class="modal-fields-container">
            <p>
              Paste CSV data below. The first row must contain column headers
              matching the table schema. Data values are automatically parsed.
            </p>
            <textarea
              id="csv-import-textarea"
              class="sql-textarea"
              placeholder="username,email&#10;alice,alice@example.com&#10;bob,bob@example.com"></textarea>
            <div class="import-upload-block">
              <span>Or upload a .csv file:</span>
              <input
                type="file"
                id="csv-file-input"
                accept=".csv"
                onchange="handleCsvFileSelect(event)"
              />
            </div>
          </div>
          <div class="modal-actions">
            <button
              type="button"
              class="btn btn-secondary"
              onclick="closeImportModal()">
              Cancel
            </button>
            <button
              type="button"
              class="btn btn-primary"
              onclick="submitImportCsv()">
              Import Rows
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
