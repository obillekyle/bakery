export function renderStatsPanel() {
  return (
    <div id="panel-stats" class="panel active">
      <div class="grid-stats">
        <div class="card glass-effect">
          <span class="card-title">Process Uptime</span>
          <span class="card-value" id="stat-uptime">
            0s
          </span>
          <span class="card-sub" id="stat-pid">
            PID: -
          </span>
        </div>
        <div class="card glass-effect">
          <span class="card-title">Ping Latency</span>
          <span class="card-value" id="stat-ping">
            0 ms
          </span>
          <span class="card-sub">Client Latency</span>
        </div>
        <div class="card glass-effect">
          <span class="card-title">Memory Allocation</span>
          <span class="card-value" id="stat-memory">
            0 MB
          </span>
          <span class="card-sub" id="stat-mem-total">
            Total Alloc
          </span>
        </div>
        <div class="card glass-effect">
          <span class="card-title">Active Loggers</span>
          <span class="card-value" id="stat-loggers">
            0
          </span>
          <span class="card-sub">Connections</span>
        </div>
        <div class="card glass-effect">
          <span class="card-title">Active Sessions</span>
          <span class="card-value" id="stat-sessions">
            0
          </span>
          <span class="card-sub">In-Memory Store</span>
        </div>
        <div class="card glass-effect">
          <span class="card-title">Bun Runtime</span>
          <span class="card-value" id="stat-bun-version">
            v-
          </span>
          <span class="card-sub" id="stat-arch">
            Architecture
          </span>
        </div>
      </div>

      <div class="section-header">
        <h2>
          <iconify-icon icon="lucide:area-chart"></iconify-icon>
          <span>Performance History</span>
        </h2>
        <div class="timescale-selector">
          <button
            type="button"
            class="timescale-btn active"
            id="timescale-1m"
            onclick="changeTimescale('1m')">
            1m
          </button>
          <button
            type="button"
            class="timescale-btn"
            id="timescale-1h"
            onclick="changeTimescale('1h')">
            1h
          </button>
          <button
            type="button"
            class="timescale-btn"
            id="timescale-1d"
            onclick="changeTimescale('1d')">
            1d
          </button>
          <button
            type="button"
            class="timescale-btn"
            id="timescale-7d"
            onclick="changeTimescale('7d')">
            7d
          </button>
          <button
            type="button"
            class="timescale-btn"
            id="timescale-30d"
            onclick="changeTimescale('30d')">
            30d
          </button>
        </div>
      </div>

      <div class="grid-charts">
        <div class="chart-card glass-effect">
          <span class="card-title">Ping Latency History</span>
          <span class="card-sub">
            Client-to-server connection latency (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-ping" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="ping-min">-</strong>
            </span>
            <span>
              MAX: <strong id="ping-max">-</strong>
            </span>
            <span>
              AVG: <strong id="ping-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect">
          <span class="card-title">Memory History</span>
          <span class="card-sub">
            Heap/RSS RAM consumption (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-memory" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="memory-min">-</strong>
            </span>
            <span>
              MAX: <strong id="memory-max">-</strong>
            </span>
            <span>
              AVG: <strong id="memory-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect">
          <span class="card-title">WebSocket Connections</span>
          <span class="card-sub">
            Active client logger tunnels (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-loggers" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="loggers-min">-</strong>
            </span>
            <span>
              MAX: <strong id="loggers-max">-</strong>
            </span>
            <span>
              AVG: <strong id="loggers-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect">
          <span class="card-title">Active Sessions</span>
          <span class="card-sub">
            In-memory active user sessions (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-sessions" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="sessions-min">-</strong>
            </span>
            <span>
              MAX: <strong id="sessions-max">-</strong>
            </span>
            <span>
              AVG: <strong id="sessions-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect" id="chart-route-hits">
          <span class="card-title">Page Route Hits History</span>
          <span class="card-sub">
            Application page requests (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-route-hits" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="pageHits-min">-</strong>
            </span>
            <span>
              MAX: <strong id="pageHits-max">-</strong>
            </span>
            <span>
              AVG: <strong id="pageHits-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect" id="chart-api-hits">
          <span class="card-title">API Hits History</span>
          <span class="card-sub">
            API endpoint requests (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-api-hits" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="apiHits-min">-</strong>
            </span>
            <span>
              MAX: <strong id="apiHits-max">-</strong>
            </span>
            <span>
              AVG: <strong id="apiHits-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect" id="chart-unique-requests">
          <span class="card-title">Unique Requests History</span>
          <span class="card-sub">
            Distinct request signatures (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-unique-requests" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="uniqueRequests-min">-</strong>
            </span>
            <span>
              MAX: <strong id="uniqueRequests-max">-</strong>
            </span>
            <span>
              AVG: <strong id="uniqueRequests-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect" id="chart-db-hits">
          <span class="card-title">DB Hits History</span>
          <span class="card-sub">
            Database query executions (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-db-hits" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="dbHits-min">-</strong>
            </span>
            <span>
              MAX: <strong id="dbHits-max">-</strong>
            </span>
            <span>
              AVG: <strong id="dbHits-avg">-</strong>
            </span>
          </div>
        </div>
        <div class="chart-card glass-effect" id="chart-error-page-hits">
          <span class="card-title">Error Page Hits History</span>
          <span class="card-sub">
            Custom error page renders (last 1 min, 1s resolution)
          </span>
          <canvas id="canvas-error-page-hits" class="big-chart"></canvas>
          <div class="chart-stats">
            <span>
              MIN: <strong id="errorPageHits-min">-</strong>
            </span>
            <span>
              MAX: <strong id="errorPageHits-max">-</strong>
            </span>
            <span>
              AVG: <strong id="errorPageHits-avg">-</strong>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
