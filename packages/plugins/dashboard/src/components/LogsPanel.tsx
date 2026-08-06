export function renderLogsPanel() {
  return (
    <div id="panel-logs" class="panel">
      <div class="card glass-effect">
        <div class="actions-row">
          <h2>Real-time Server Logs</h2>
          <div class="actions-group">
            <button
              type="button"
              class="btn btn-secondary"
              onclick="toggleLogsPlay()"
              id="btn-logs-play">
              <iconify-icon icon="lucide:pause"></iconify-icon>
              <span>Pause</span>
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-danger"
              onclick="clearLogs()">
              <iconify-icon icon="lucide:trash-2"></iconify-icon>
              <span>Clear Logs</span>
            </button>
            <label>
              <input type="checkbox" id="logs-autoscroll" checked />{' '}
              Auto-scroll
            </label>
          </div>
        </div>

        <div id="logs-console" class="log-console">
          <div class="text-secondary">
            Connecting to server log stream...
          </div>
        </div>
      </div>
    </div>
  )
}
