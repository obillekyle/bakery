/**
 * The live feed: the socket, the polling fallback, and everything that writes
 * a number into the page.
 *
 * This file was 999 lines and held four jobs. Three of them left, along the
 * seams they already read as: `metrics.ts` is what the charts *are*,
 * `sparkline.ts` is how one is drawn, `sparkline-tooltip.ts` is the tooltip
 * over it. What is left here is the part that changes over time, which is the
 * only part with any state a request can move.
 *
 * The dependency runs one way through all four — tooltip and feed both reach
 * for drawing, drawing reaches for the catalogue, and the catalogue reaches for
 * nothing — so no pair of them can close a cycle.
 */

import { formatUptime, getWebSocketUrl, setEmpty, setText } from './utils'
import {
  activeTimescale,
  emptyTracker,
  getTimescaleIntervalMs,
  getTimescaleLimit,
  memoryHistory,
  METRICS,
  type Metric,
  readLive,
  readPoint,
  setActiveTimescale,
  trackers,
  updateTracker,
} from './metrics'
import { drawAllSparklines } from './sparkline'
import { refreshSparklineTooltips } from './sparkline-tooltip'

export let lastProcessedHistoryTimestamp = 0
export let lastServerPid = 0
export let connectionLost = false

function setConnectionStatus(online: boolean) {
  const dot = document.getElementById('server-status-dot')
  const text = document.getElementById('server-status-text')
  if (!dot || !text) return

  if (online) {
    dot.style.background = '#10b981'
    dot.style.boxShadow = '0 0 10px rgba(16, 185, 129, 0.4)'
    text.innerText = 'Online (DEV)'
    text.style.color = 'var(--text)'
  } else {
    dot.style.background = '#ef4444'
    dot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.4)'
    text.innerText = 'Offline'
    text.style.color = '#ef4444'
  }
}
export let activePagesFilter = '1d'

export function changePagesFilter(newFilter: string) {
  activePagesFilter = newFilter
  document.querySelectorAll('.pages-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === `pages-filter-${newFilter}`)
  })
  loadStats(true)
}

export async function resetAnalytics() {
  if (
    !confirm(
      'Are you sure you want to reset all analytics data? This will clear all history and page visit records.',
    )
  ) {
    return
  }
  try {
    const res = await fetch('/api/_analytics/reset', {
      method: 'POST',
    })
    if (res.status === 200) {
      alert('Analytics data reset successfully.')
      loadStats(true)
    } else {
      alert('Failed to reset analytics data.')
    }
  } catch (err) {
    console.error('Reset analytics error:', err)
    alert('An error occurred while resetting analytics data.')
  }
}

export let analyticsWs: WebSocket | null = null
let reconnectTimer: any = null

export function initAnalyticsWebSocket() {
  if (analyticsWs) return
  analyticsWs = new WebSocket(getWebSocketUrl('/_analytics_ws'))

  analyticsWs.onopen = () => {
    setConnectionStatus(true)
    connectionLost = false
    loadStats(true)
  }

  analyticsWs.onmessage = event => {
    try {
      const data = JSON.parse(event.data)
      if (data.status === 200) {
        processStatsData(data.data, data.excludeHistory)
      } else if (data.status === 401) {
        window.location.reload()
      }
    } catch (e) {
      console.error('WebSocket Error:', e)
    }
  }

  analyticsWs.onclose = () => {
    analyticsWs = null
    if (!connectionLost) {
      connectionLost = true
      setConnectionStatus(false)
    }
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(initAnalyticsWebSocket, 3000)
  }
}

export function loadStats(forceFullHistory = false) {
  const excludeHistory = !forceFullHistory && memoryHistory.length > 0
  if (analyticsWs && analyticsWs.readyState === WebSocket.OPEN) {
    analyticsWs.send(
      JSON.stringify({
        type: 'subscribe',
        timescale: activeTimescale,
        pagesFilter: activePagesFilter,
        excludeHistory,
      }),
    )
  }
}

function updateStatsUIElements(s: any) {
  setText('stat-uptime', formatUptime(s.uptimeSeconds || 0))
  setText('stat-pid', `PID: ${s.pid}`)
  setText('stat-memory', s.memoryUsed)
  setText('stat-mem-total', `External: ${s.memoryExternal}`)
  setText('stat-bun-version', s.bunVersion)
  setText('stat-arch', `${s.platform} (${s.arch})`)
  setText('stat-loggers', s.activeLoggers)
  setText('stat-sessions', s.activeSessions)
  setText('stat-ping', `${s.ping ?? 0} ms`)
}

function updateAnalyticsActiveState(isAnalyticsActive: boolean) {
  for (const m of METRICS) {
    if (!m.card) continue
    const el = document.getElementById(m.card)
    if (el) el.classList.toggle('blurred-stats', !isAnalyticsActive)
  }
}

function resetTrackers() {
  for (const key in trackers) trackers[key] = emptyTracker()
}

function processStatsHistoryList(history: any[]) {
  for (const m of METRICS) m.history.length = 0
  resetTrackers()

  history.forEach((item: any) => {
    for (const m of METRICS) {
      const val = readPoint(m, item)
      m.history.push(val)
      updateTracker(m.key, val)
    }
  })

  lastProcessedHistoryTimestamp = history[history.length - 1].timestamp
  drawAllSparklines()
}

function updateHistoryField(m: Metric, val: number, limit: number) {
  m.history.push(val)
  while (m.history.length > limit) {
    m.history.shift()
  }
  updateTracker(m.key, val)
}

function processStatsIncrementalMinute(s: any) {
  const limit = getTimescaleLimit('1m')
  for (const m of METRICS) updateHistoryField(m, readLive(m, s), limit)

  if (s.latestHistoryPoint?.timestamp) {
    lastProcessedHistoryTimestamp = s.latestHistoryPoint.timestamp
  }

  drawAllSparklines()
}

function processStatsIncrementalStandard(s: any) {
  const lp = s.latestHistoryPoint
  if (lp && lp.timestamp > lastProcessedHistoryTimestamp) {
    const limit = getTimescaleLimit(activeTimescale)
    for (const m of METRICS) updateHistoryField(m, readPoint(m, lp), limit)

    lastProcessedHistoryTimestamp = lp.timestamp
    drawAllSparklines()
  }
}

function updateTopPagesList(topPages: any[]) {
  const topPagesListContainer = document.getElementById(
    'top-pages-list-container',
  )
  if (!topPagesListContainer) return

  if (topPages.length === 0) {
    setEmpty(topPagesListContainer, 'No page hits recorded for this period.')
    return
  }

  let html = `
    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
      <div style="display: grid; grid-template-columns: 1fr auto; font-weight: 600; font-size: 0.8rem; color: var(--text-muted); border-bottom: 1px solid var(--border); padding-bottom: 0.5rem;">
        <span>Page Path</span>
        <span style="text-align: right; min-width: 80px;">Hits</span>
      </div>
  `

  topPages.forEach((p: any) => {
    html += `
      <div style="display: grid; grid-template-columns: 1fr auto; align-items: center; font-size: 0.85rem; padding: 0.25rem 0;">
        <div style="display: flex; flex-direction: column; gap: 0.4rem; overflow: hidden; padding-right: 1rem;">
          <span style="font-family: var(--mono); color: var(--text); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHTML(p.page)}</span>
        </div>
        <span style="text-align: right; font-weight: 600; font-family: var(--mono); color: var(--text); min-width: 80px;">${p.hits.toLocaleString()}</span>
      </div>
    `
  })

  html += '</div>'
  topPagesListContainer.innerHTML = html

}

export function processStatsData(s: any, excludeHistory: boolean) {
  let shouldForceFull = false
  if (connectionLost) {
    shouldForceFull = true
    connectionLost = false
    setConnectionStatus(true)
  }
  if (lastServerPid && lastServerPid !== s.pid) {
    shouldForceFull = true
  }
  lastServerPid = s.pid

  const newTimestamp = s.latestHistoryPoint?.timestamp || 0
  if (lastProcessedHistoryTimestamp && newTimestamp) {
    const interval = getTimescaleIntervalMs(activeTimescale)
    if (newTimestamp - lastProcessedHistoryTimestamp > interval * 2.5) {
      shouldForceFull = true
    }
  }

  if (shouldForceFull && excludeHistory) {
    loadStats(true)
    return
  }

  updateStatsUIElements(s)
  updateAnalyticsActiveState(s.analyticsActive !== false)

  if (s.history && s.history.length > 0) {
    processStatsHistoryList(s.history)
  } else if (activeTimescale === '1m') {
    processStatsIncrementalMinute(s)
  } else {
    processStatsIncrementalStandard(s)
  }

  refreshSparklineTooltips()
  updateTopPagesList(s.topPages)
}

export function changeTimescale(newTimescale: string) {
  setActiveTimescale(newTimescale)

  document.querySelectorAll('.timescale-btn').forEach(btn => {
    btn.classList.toggle('active', btn.id === `timescale-${newTimescale}`)
  })

  const labelMap: Record<string, string> = {
    '1m': '(last 1 min, 1s resolution)',
    '1h': '(last 60 min, 1m resolution)',
    '1d': '(last 24 hours, 30m resolution)',
    '7d': '(last 7 days, 6h resolution)',
    '30d': '(last 30 days, 1d resolution)',
  }
  for (const m of METRICS) {
    const canvas = document.getElementById(m.canvas)
    const subEl = canvas?.closest('.chart-card')?.querySelector('.card-sub')
    if (subEl) subEl.textContent = `${m.sub} ${labelMap[newTimescale]}`

    m.history.length = 0
    setText(`${m.key}-min`, '-')
    setText(`${m.key}-max`, '-')
    setText(`${m.key}-avg`, '-')
  }

  resetTrackers()
  lastProcessedHistoryTimestamp = 0
  drawAllSparklines()
  loadStats(true)
}
