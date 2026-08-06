export function renderTopPagesPanel() {
  return (
    <div id="panel-top-pages" class="panel">
      <div class="section-header">
        <h2>
          <iconify-icon icon="lucide:file-text"></iconify-icon>
          <span>Top Visited Pages</span>
        </h2>
        <div class="timescale-selector">
          <button
            type="button"
            class="pages-filter-btn"
            id="pages-filter-1m"
            onclick="changePagesFilter('1m')">
            1m
          </button>
          <button
            type="button"
            class="pages-filter-btn"
            id="pages-filter-1h"
            onclick="changePagesFilter('1h')">
            1h
          </button>
          <button
            type="button"
            class="pages-filter-btn active"
            id="pages-filter-1d"
            onclick="changePagesFilter('1d')">
            1d
          </button>
          <button
            type="button"
            class="pages-filter-btn"
            id="pages-filter-7d"
            onclick="changePagesFilter('7d')">
            7d
          </button>
          <button
            type="button"
            class="pages-filter-btn"
            id="pages-filter-30d"
            onclick="changePagesFilter('30d')">
            30d
          </button>
        </div>
      </div>

      <div class="card glass-effect top-pages-card">
        <div id="top-pages-list-container">
          <div class="results-empty">
            <span>Loading top pages...</span>
          </div>
        </div>
      </div>
    </div>
  )
}
