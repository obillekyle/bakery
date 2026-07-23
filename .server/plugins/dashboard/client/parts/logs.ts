import { colorizeHtml, getWebSocketUrl } from './utils'

export let logsWs: WebSocket | null = null
export let logsPaused = false

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

  logRow.innerHTML = `
    <span style="color: var(--text-secondary); margin-right: 0.5rem;">[${timestamp}]</span>
    <span style="color: ${levelColor}; font-weight: bold; margin-right: 0.5rem;">[${level}]</span>
    <span style="color: #60a5fa; font-weight: 500; margin-right: 0.5rem;">${by}:</span>
    <span style="color: #f1f5f9; white-space: pre-wrap;">${colorizeHtml(payload)}</span>
  `

  cEl.appendChild(logRow)
  scrollConsoleToBottom(cEl)
}

function renderRawLogEntry(cEl: HTMLElement, rawData: string) {
  const logRow = document.createElement('div')
  logRow.style.color = '#cbd5e1'
  logRow.innerText = rawData
  cEl.appendChild(logRow)
  scrollConsoleToBottom(cEl)
}

export function initLogsWebSocket() {
  if (logsWs && logsWs.readyState === WebSocket.OPEN) return

  const consoleEl = document.getElementById('logs-console')
  if (!consoleEl) return
  consoleEl.innerHTML =
    '<div style="color: var(--text-secondary);">Connecting to server log stream...</div>'

  try {
    logsWs = new WebSocket(getWebSocketUrl('/_livereload'))

    logsWs.onopen = () => {
      consoleEl.innerHTML =
        '<div style="color: var(--accent-green); display: flex; align-items: center; gap: 0.25rem;"><iconify-icon icon="lucide:check-circle-2" style="font-size: 1.1rem;"></iconify-icon><span>Connected to logs pipeline. Listening for events...</span></div>'
      logsWs?.send(JSON.stringify({ type: 'subscribe_logger' }))
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
        '<span style="display: flex; align-items: center; gap: 0.25rem;"><iconify-icon icon="lucide:alert-triangle" style="font-size: 1rem;"></iconify-icon><span>Logs pipeline disconnected. Reconnecting in 3s...</span></span>'
      consoleEl.appendChild(logRow)
      setTimeout(initLogsWebSocket, 3000)
    }
  } catch (_err) {
    consoleEl.innerHTML =
      '<div style="color: var(--accent-red);">Failed to establish log stream connection.</div>'
  }
}

export function toggleLogsPlay() {
  logsPaused = !logsPaused
  const btn = document.getElementById('btn-logs-play')
  if (btn) {
    btn.innerHTML = logsPaused
      ? '<iconify-icon icon="lucide:play" style="font-size: 1.1rem;"></iconify-icon><span>Resume</span>'
      : '<iconify-icon icon="lucide:pause" style="font-size: 1.1rem;"></iconify-icon><span>Pause</span>'
    btn.classList.toggle('btn-success', logsPaused)
  }
}

export function clearLogs() {
  const consoleEl = document.getElementById('logs-console')
  if (consoleEl)
    consoleEl.innerHTML =
      '<div style="color: var(--text-secondary);">Console cleared.</div>'
}
