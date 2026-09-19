import { colorizeHtml, getWebSocketUrl } from './utils'

export let logsWs: WebSocket | null = null
export let logsPaused = false

/**
 * The console keeps the most recent rows only. It previously appended
 * without ever removing, so a long-lived dashboard tab on a chatty server
 * grew the DOM without bound.
 */
const MAX_LOG_ROWS = 500

function appendLogRow(cEl: HTMLElement, row: HTMLElement) {
  cEl.appendChild(row)
  while (cEl.childElementCount > MAX_LOG_ROWS) {
    cEl.removeChild(cEl.firstElementChild!)
  }
  scrollConsoleToBottom(cEl)
}

function scrollConsoleToBottom(cEl: HTMLElement) {
  const scrollCheck = document.getElementById(
    'logs-autoscroll',
  ) as HTMLInputElement | null
  if (scrollCheck?.checked) {
    cEl.scrollTop = cEl.scrollHeight
  }
}

function getLogLevelColor(level: string): string {
  if (level === 'WARN') return '#f59e0b'
  if (level === 'ERROR' || level === 'FATAL') return '#ef4444'
  if (level === 'DEBUG') return '#a855f7'
  return '#34d399'
}

function renderLogEntry(cEl: HTMLElement, parsed: any) {
  const timestamp = new Date(
    parsed.timestamp || Date.now(),
  ).toLocaleTimeString()
  const level = (parsed.level || 'info').toUpperCase()
  const by = parsed.by || 'global'
  const payload = parsed.payload || ''

  const levelColor = getLogLevelColor(level)

  const logRow = document.createElement('div')
  logRow.style.padding = '0.15rem 0'
  logRow.style.borderBottom = '1px solid rgba(255, 255, 255, 0.02)'

  // `level` and `by` arrive over the websocket. LiveReloadHandler rebroadcasts
  // client_log frames from any connected client, so both are untrusted —
  // `payload` was already escaped by colorizeHtml, these were not.
  logRow.innerHTML = `
    <span style="color: var(--text-muted); margin-right: 0.5rem;">[${escapeHTML(String(timestamp))}]</span>
    <span style="color: ${levelColor}; font-weight: bold; margin-right: 0.5rem;">[${escapeHTML(String(level))}]</span>
    <span style="color: #60a5fa; font-weight: 500; margin-right: 0.5rem;">${escapeHTML(String(by))}:</span>
    <span style="color: #f1f5f9; white-space: pre-wrap;">${colorizeHtml(payload)}</span>
  `

  appendLogRow(cEl, logRow)
}

function renderRawLogEntry(cEl: HTMLElement, rawData: string) {
  const logRow = document.createElement('div')
  logRow.style.color = '#cbd5e1'
  logRow.innerText = rawData
  appendLogRow(cEl, logRow)
}

export function initLogsWebSocket() {
  if (logsWs && logsWs.readyState === WebSocket.OPEN) return

  const consoleEl = document.getElementById('logs-console')
  if (!consoleEl) return
  consoleEl.innerHTML =
    '<div style="color: var(--text-muted);">Connecting to server log stream...</div>'

  try {
    // `/_dashboard/logs`, not `/_livereload`. The live-reload socket is
    // registered only under `DEV`, so this panel answered 400 on every
    // production server and sat on "Connecting..." for ever. The console has
    // its own socket now, behind the console's own door.
    logsWs = new WebSocket(getWebSocketUrl('/_dashboard/logs'))

    logsWs.onopen = () => {
      consoleEl.innerHTML =
        '<div style="color: var(--ok); display: flex; align-items: center; gap: 0.25rem;"><span>Connected to logs pipeline. Listening for events...</span></div>'
      // No `subscribe_logger` frame: membership is the handler's `open`, so
      // there is nothing to ask for. That message was `LiveReloadHandler`'s
      // protocol, and it is what an app page still sends to forward its own
      // console in development.
    }

    logsWs.onmessage = event => {
      if (logsPaused) return

      try {
        const parsed = JSON.parse(event.data)
        if (parsed.type === 'server_log' || parsed.type === 'client_log') {
          renderLogEntry(consoleEl, parsed)
        }
      } catch (_e) {
        renderRawLogEntry(consoleEl, event.data)
      }
    }

    logsWs.onclose = () => {
      const logRow = document.createElement('div')
      logRow.style.color = '#f59e0b'
      logRow.innerHTML =
        '<span style="display: flex; align-items: center; gap: 0.25rem;"><span>Logs pipeline disconnected. Reconnecting in 3s...</span></span>'
      consoleEl.appendChild(logRow)
      setTimeout(initLogsWebSocket, 3000)
    }
  } catch (_err) {
    consoleEl.innerHTML =
      '<div style="color: var(--danger);">Failed to establish log stream connection.</div>'
  }
}

export function toggleLogsPlay() {
  logsPaused = !logsPaused
  const btn = document.getElementById('btn-logs-play')
  if (btn) {
    btn.innerHTML = logsPaused
      ? '<span>Resume</span>'
      : '<span>Pause</span>'
    btn.classList.toggle('btn-success', logsPaused)
  }
}

export function clearLogs() {
  const consoleEl = document.getElementById('logs-console')
  if (consoleEl)
    consoleEl.innerHTML =
      '<div style="color: var(--text-muted);">Console cleared.</div>'
}
