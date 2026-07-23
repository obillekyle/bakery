import { formatUptime, getWebSocketUrl, SegmentedProgress } from './utils'

declare const is: any

export const historyPing: number[] = []
export const historyMemory: number[] = []
export const historyLoggers: number[] = []
export const historySessions: number[] = []
export const historyPageHits: number[] = []
export const historyApiHits: number[] = []
export const historyUniqueRequests: number[] = []
export const historyDbHits: number[] = []
export const historyErrorPageHits: number[] = []

export let activeTimescale = '1m'
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
    text.style.color = 'var(--text-main)'
  } else {
    dot.style.background = '#ef4444'
    dot.style.boxShadow = '0 0 10px rgba(239, 68, 68, 0.4)'
    text.innerText = 'Offline'
    text.style.color = '#ef4444'
  }
}
export let activePagesFilter = '1d'
export let activeTopPagesProgressBars: SegmentedProgress[] = []

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

function getTimescaleIntervalMs(timescale: string): number {
  switch (timescale) {
    case '30d':
      return 86400000
    case '7d':
      return 21600000
    case '1d':
      return 1800000
    case '1h':
      return 60000
    default:
      return 1000
  }
}

interface Tracker {
  min: number
  max: number
  sum: number
  count: number
}

export const trackers: Record<string, Tracker> = {
  ping: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  memory: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  loggers: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  sessions: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  pageHits: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  apiHits: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  uniqueRequests: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  dbHits: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
  errorPageHits: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
}

export function updateTracker(key: string, val: number) {
  if (val === null || val === undefined || Number.isNaN(val)) return
  const t = trackers[key]
  if (val < t.min) t.min = val
  if (val > t.max) t.max = val
  t.sum += val
  t.count += 1
  const avg = t.sum / t.count

  const suffix = key === 'ping' ? 'ms' : key === 'memory' ? 'MB' : ''
  const minEl = document.getElementById(`${key}-min`)
  const maxEl = document.getElementById(`${key}-max`)
  const avgEl = document.getElementById(`${key}-avg`)
  if (minEl) minEl.innerText = `${t.min.toFixed(0)} ${suffix}`
  if (maxEl) maxEl.innerText = `${t.max.toFixed(0)} ${suffix}`
  if (avgEl) avgEl.innerText = `${avg.toFixed(1)} ${suffix}`
}

function drawSparklineGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  min: number,
  range: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
  ctx.lineWidth = 1

  const gridLines = [0.25, 0.5, 0.75]
  gridLines.forEach(ratio => {
    const y = height - 12 - ratio * (height - 24)
    ctx.moveTo(0, y)
    ctx.lineTo(width - 50, y)

    const val = min + ratio * range
    const roundedVal = range < 5 ? Math.round(val * 10) / 10 : Math.round(val)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.font = '9px monospace'
    ctx.fillText(roundedVal.toString(), width - 42, y + 3)
  })
  ctx.stroke()
  ctx.restore()
}

function getSparklineSegments(dataPoints: number[]) {
  const segments: { start: number; end: number }[] = []
  let inSegment = false
  let segmentStart = 0

  for (let i = 0; i < dataPoints.length; i++) {
    const isValValid =
      dataPoints[i] !== null &&
      dataPoints[i] !== undefined &&
      !Number.isNaN(dataPoints[i])
    if (isValValid) {
      if (!inSegment) {
        inSegment = true
        segmentStart = i
      }
    } else {
      if (inSegment) {
        segments.push({ start: segmentStart, end: i - 1 })
        inSegment = false
      }
    }
  }
  if (inSegment) {
    segments.push({ start: segmentStart, end: dataPoints.length - 1 })
  }
  return segments
}

function drawSinglePointSegment(
  ctx: CanvasRenderingContext2D,
  start: number,
  dataPoints: number[],
  min: number,
  max: number,
  range: number,
  width: number,
  height: number,
  L: number,
  M: number,
  colorStart: string,
) {
  const val = Math.max(min, Math.min(dataPoints[start], max))
  const j = L - M + start
  const x = (j / (L - 1)) * (width - 50)
  const y = height - 12 - ((val - min) / range) * (height - 24)

  ctx.beginPath()
  ctx.arc(x, y, 2.5, 0, Math.PI * 2)
  ctx.fillStyle = colorStart
  ctx.fill()
}

function drawLineSegment(
  ctx: CanvasRenderingContext2D,
  start: number,
  end: number,
  dataPoints: number[],
  min: number,
  max: number,
  range: number,
  width: number,
  height: number,
  L: number,
  M: number,
  colorStart: string,
) {
  ctx.beginPath()
  for (let i = start; i <= end; i++) {
    const val = Math.max(min, Math.min(dataPoints[i], max))
    const j = L - M + i
    const x = (j / (L - 1)) * (width - 50)
    const y = height - 12 - ((val - min) / range) * (height - 24)
    if (i === start) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.lineWidth = 2.5
  ctx.strokeStyle = colorStart
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.stroke()
}

function drawFillSegment(
  ctx: CanvasRenderingContext2D,
  start: number,
  end: number,
  dataPoints: number[],
  min: number,
  max: number,
  range: number,
  width: number,
  height: number,
  L: number,
  M: number,
  colorEnd: string,
) {
  ctx.beginPath()
  let firstX = 0
  let lastX = 0
  for (let i = start; i <= end; i++) {
    const val = Math.max(min, Math.min(dataPoints[i], max))
    const j = L - M + i
    const x = (j / (L - 1)) * (width - 50)
    const y = height - 12 - ((val - min) / range) * (height - 24)
    if (i === start) {
      ctx.moveTo(x, y)
      firstX = x
    } else {
      ctx.lineTo(x, y)
    }
    if (i === end) {
      lastX = x
    }
  }
  ctx.lineTo(lastX, height)
  ctx.lineTo(firstX, height)
  ctx.closePath()

  const gradient = ctx.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, colorEnd)
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)')
  ctx.fillStyle = gradient
  ctx.fill()
}

export function drawSparkline(
  canvasId: string,
  dataPoints: number[],
  colorStart: string,
  colorEnd: string,
) {
  const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * dpr
  canvas.height = rect.height * dpr
  ctx.scale(dpr, dpr)

  const width = rect.width
  const height = rect.height
  ctx.clearRect(0, 0, width, height)

  if (dataPoints.length === 0) return

  const { min, max, range } = getSparklineScale(dataPoints)
  drawSparklineGrid(ctx, width, height, min, range)

  const L = getTimescaleLimit(activeTimescale)
  const M = dataPoints.length
  const segments = getSparklineSegments(dataPoints)

  if (segments.length === 0) return

  segments.forEach(segment => {
    if (segment.start === segment.end) {
      drawSinglePointSegment(
        ctx,
        segment.start,
        dataPoints,
        min,
        max,
        range,
        width,
        height,
        L,
        M,
        colorStart,
      )
    } else {
      drawLineSegment(
        ctx,
        segment.start,
        segment.end,
        dataPoints,
        min,
        max,
        range,
        width,
        height,
        L,
        M,
        colorStart,
      )
      drawFillSegment(
        ctx,
        segment.start,
        segment.end,
        dataPoints,
        min,
        max,
        range,
        width,
        height,
        L,
        M,
        colorEnd,
      )
    }
  })
}

interface SparklineTooltipConfig {
  canvasId: string
  history: number[]
  unitSuffix: string
}

interface SparklineHoverState {
  visible: boolean
  clientX: number
  clientY: number
}

export const sparklineTooltipConfigs: SparklineTooltipConfig[] = [
  { canvasId: 'canvas-ping', history: historyPing, unitSuffix: 'ms' },
  { canvasId: 'canvas-memory', history: historyMemory, unitSuffix: ' MB' },
  { canvasId: 'canvas-loggers', history: historyLoggers, unitSuffix: '' },
  { canvasId: 'canvas-sessions', history: historySessions, unitSuffix: '' },
  { canvasId: 'canvas-route-hits', history: historyPageHits, unitSuffix: '' },
  { canvasId: 'canvas-api-hits', history: historyApiHits, unitSuffix: '' },
  {
    canvasId: 'canvas-unique-requests',
    history: historyUniqueRequests,
    unitSuffix: '',
  },
  { canvasId: 'canvas-db-hits', history: historyDbHits, unitSuffix: '' },
  {
    canvasId: 'canvas-error-page-hits',
    history: historyErrorPageHits,
    unitSuffix: '',
  },
]

export const sparklineHoverStates: Record<string, SparklineHoverState> = {}

function getSparklineScale(dataPoints: number[]) {
  const validPoints = dataPoints.filter(
    p =>
      typeof p === 'number' &&
      !Number.isNaN(p) &&
      p !== null &&
      p !== undefined,
  )
  if (validPoints.length === 0) {
    return { min: 0, max: 0, range: 1 }
  }
  const sum = validPoints.reduce((a, b) => a + b, 0)
  const avg = sum / validPoints.length || 1
  const actualMax = Math.max(...validPoints)
  const min = 0
  const max = Math.max(avg * 2, actualMax, 50)
  const range = max - min === 0 ? 1 : max - min
  return { min, max, range }
}

function ensureSparklineTooltip(canvas: HTMLCanvasElement) {
  const chartCard = canvas.closest('.chart-card') as HTMLElement | null
  if (!chartCard) return null

  let tooltip = chartCard.querySelector('.chart-tooltip') as HTMLElement | null
  if (!tooltip) {
    tooltip = document.createElement('div')
    tooltip.className = 'chart-tooltip'
    chartCard.appendChild(tooltip)
  }

  return tooltip
}

function formatSparklineTooltipValue(value: number, unitSuffix: string) {
  return Math.round(value).toString() + unitSuffix
}

function formatAge30d(agePoints: number): string {
  return agePoints === 1 ? '1 day ago' : `${agePoints} days ago`
}

function formatAge7d(agePoints: number): string {
  const hours = agePoints * 6
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`
  }
  return `${hours}h ago`
}

function formatAge1d(agePoints: number): string {
  const mins = agePoints * 30
  if (mins >= 60) {
    const hours = Math.floor(mins / 60)
    const remMins = mins % 60
    return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`
  }
  return `${mins}m ago`
}

function formatAgeOther(agePoints: number, activeTimescale: string): string {
  if (activeTimescale === '1h') {
    return agePoints === 1 ? '1 min ago' : `${agePoints} mins ago`
  }
  return agePoints === 1 ? '1s ago' : `${agePoints}s ago`
}

function formatSparklineAge(index: number, length: number) {
  const agePoints = Math.max(length - 1 - index, 0)
  if (agePoints === 0) return 'now'

  if (activeTimescale === '30d') return formatAge30d(agePoints)
  if (activeTimescale === '7d') return formatAge7d(agePoints)
  if (activeTimescale === '1d') return formatAge1d(agePoints)
  return formatAgeOther(agePoints, activeTimescale)
}

export function updateSparklineTooltip(config: SparklineTooltipConfig) {
  const state = sparklineHoverStates[config.canvasId]
  if (!state?.visible) return

  const canvas = document.getElementById(
    config.canvasId,
  ) as HTMLCanvasElement | null
  if (!canvas) return

  const tooltip = ensureSparklineTooltip(canvas)
  if (!tooltip) return

  const data = config.history
  if (data.length === 0) {
    tooltip.classList.remove('visible')
    return
  }

  const rect = canvas.getBoundingClientRect()
  const chartCard = canvas.closest('.chart-card') as HTMLElement | null
  const chartRect = chartCard?.getBoundingClientRect() || rect
  const { min, max, range } = getSparklineScale(data)
  const graphWidth = Math.max(rect.width - 50, 1)
  const graphHeight = Math.max(rect.height - 24, 1)
  const localX = Math.min(Math.max(state.clientX - rect.left, 0), graphWidth)

  const L = getTimescaleLimit(activeTimescale)
  const M = data.length
  const j = L === 1 ? 0 : Math.round((localX / graphWidth) * (L - 1))
  const index = j - (L - M)

  if (index < 0 || index >= M) {
    tooltip.classList.remove('visible')
    return
  }

  const value = data[index]
  if (value === null || value === undefined || Number.isNaN(value)) {
    tooltip.classList.remove('visible')
    return
  }
  const safeValue = Math.max(min, Math.min(value, max))
  const pointX = L === 1 ? 0 : (j / (L - 1)) * graphWidth
  const pointY = rect.height - 12 - ((safeValue - min) / range) * graphHeight

  tooltip.textContent = `${formatSparklineTooltipValue(value, config.unitSuffix)} (${formatSparklineAge(index, data.length)})`
  tooltip.dataset.placement = pointY < 28 ? 'below' : 'above'
  tooltip.style.left = `${rect.left - chartRect.left + pointX}px`
  tooltip.style.top = `${rect.top - chartRect.top + pointY}px`
  tooltip.classList.add('visible')
}

export function refreshSparklineTooltips() {
  for (const config of sparklineTooltipConfigs) {
    updateSparklineTooltip(config)
  }
}

export function bindSparklineTooltips() {
  for (const config of sparklineTooltipConfigs) {
    const canvas = document.getElementById(
      config.canvasId,
    ) as HTMLCanvasElement | null
    if (!canvas || canvas.dataset.sparklineTooltipBound === 'true') continue

    canvas.dataset.sparklineTooltipBound = 'true'
    sparklineHoverStates[config.canvasId] = {
      visible: false,
      clientX: 0,
      clientY: 0,
    }

    const state = sparklineHoverStates[config.canvasId]

    canvas.addEventListener('pointermove', event => {
      state.visible = true
      state.clientX = event.clientX
      state.clientY = event.clientY
      updateSparklineTooltip(config)
    })

    canvas.addEventListener('pointerleave', () => {
      state.visible = false
      const tooltip = ensureSparklineTooltip(canvas)
      if (tooltip) tooltip.classList.remove('visible')
    })
  }

  window.addEventListener('resize', refreshSparklineTooltips, {
    passive: true,
  })
  window.addEventListener('scroll', refreshSparklineTooltips, {
    passive: true,
  })
}

function getTimescaleLimit(timescale: string): number {
  switch (timescale) {
    case '30d':
      return 30
    case '7d':
      return 28
    case '1d':
      return 48
    case '1h':
      return 60
    default:
      return 60
  }
}

export function drawAllSparklines() {
  drawSparkline(
    'canvas-ping',
    historyPing,
    '#f43f5e',
    'rgba(244, 63, 94, 0.25)',
  )
  drawSparkline(
    'canvas-memory',
    historyMemory,
    '#3b82f6',
    'rgba(59, 130, 246, 0.25)',
  )
  drawSparkline(
    'canvas-loggers',
    historyLoggers,
    '#10b981',
    'rgba(16, 185, 129, 0.25)',
  )
  drawSparkline(
    'canvas-sessions',
    historySessions,
    '#fbbf24',
    'rgba(251, 191, 36, 0.25)',
  )
  drawSparkline(
    'canvas-route-hits',
    historyPageHits,
    '#06b6d4',
    'rgba(6, 182, 212, 0.25)',
  )
  drawSparkline(
    'canvas-api-hits',
    historyApiHits,
    '#8b5cf6',
    'rgba(139, 92, 246, 0.25)',
  )
  drawSparkline(
    'canvas-unique-requests',
    historyUniqueRequests,
    '#f97316',
    'rgba(249, 115, 22, 0.25)',
  )
  drawSparkline(
    'canvas-db-hits',
    historyDbHits,
    '#a78bfa',
    'rgba(167, 139, 250, 0.25)',
  )
  drawSparkline(
    'canvas-error-page-hits',
    historyErrorPageHits,
    '#ef4444',
    'rgba(239, 68, 68, 0.25)',
  )
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
  const excludeHistory = !forceFullHistory && historyMemory.length > 0
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
  const uptimeEl = document.getElementById('stat-uptime')
  if (uptimeEl) uptimeEl.innerText = formatUptime(s.uptimeSeconds || 0)

  const pidEl = document.getElementById('stat-pid')
  const memoryEl = document.getElementById('stat-memory')
  const memTotalEl = document.getElementById('stat-mem-total')
  const bunVersionEl = document.getElementById('stat-bun-version')
  const archEl = document.getElementById('stat-arch')
  const loggersEl = document.getElementById('stat-loggers')
  const sessionsEl = document.getElementById('stat-sessions')
  const pingEl = document.getElementById('stat-ping')

  if (pidEl) pidEl.innerText = `PID: ${s.pid}`
  if (memoryEl) memoryEl.innerText = s.memoryUsed
  if (memTotalEl) memTotalEl.innerText = `External: ${s.memoryExternal}`
  if (bunVersionEl) bunVersionEl.innerText = s.bunVersion
  if (archEl) archEl.innerText = `${s.platform} (${s.arch})`
  if (loggersEl) loggersEl.innerText = s.activeLoggers
  if (sessionsEl) sessionsEl.innerText = s.activeSessions

  const serverPingVal = s.ping ?? 0
  if (pingEl) pingEl.innerText = `${serverPingVal} ms`
}

function updateAnalyticsActiveState(isAnalyticsActive: boolean) {
  const chartIds = [
    'chart-route-hits',
    'chart-api-hits',
    'chart-unique-requests',
    'chart-db-hits',
    'chart-error-page-hits',
  ]
  chartIds.forEach(id => {
    const el = document.getElementById(id)
    if (el) {
      el.classList.toggle('blurred-stats', !isAnalyticsActive)
    }
  })
}

function processStatsHistoryList(history: any[]) {
  historyMemory.length = 0
  historyLoggers.length = 0
  historySessions.length = 0
  historyPageHits.length = 0
  historyApiHits.length = 0
  historyUniqueRequests.length = 0
  historyDbHits.length = 0
  historyErrorPageHits.length = 0
  historyPing.length = 0

  for (const key in trackers) {
    trackers[key] = { min: Infinity, max: -Infinity, sum: 0, count: 0 }
  }

  history.forEach((item: any) => {
    historyMemory.push(item.memoryUsed)
    historyLoggers.push(item.activeLoggers)
    historySessions.push(item.activeSessions)
    historyPageHits.push(item.pageHits || 0)
    historyApiHits.push(item.apiHits || 0)
    historyUniqueRequests.push(item.uniqueRequests || 0)
    historyDbHits.push(item.dbHits || 0)
    historyErrorPageHits.push(item.errorPageHits || 0)
    historyPing.push(item.ping || 0)

    updateTracker('memory', item.memoryUsed)
    updateTracker('loggers', item.activeLoggers)
    updateTracker('sessions', item.activeSessions)
    updateTracker('pageHits', item.pageHits || 0)
    updateTracker('apiHits', item.apiHits || 0)
    updateTracker('uniqueRequests', item.uniqueRequests || 0)
    updateTracker('dbHits', item.dbHits || 0)
    updateTracker('errorPageHits', item.errorPageHits || 0)
    updateTracker('ping', item.ping || 0)
  })

  lastProcessedHistoryTimestamp = history[history.length - 1].timestamp
  drawAllSparklines()
}

function updateHistoryField(
  historyArray: number[],
  trackerKey: string,
  val: number,
  limit: number,
) {
  historyArray.push(val)
  while (historyArray.length > limit) {
    historyArray.shift()
  }
  updateTracker(trackerKey, val)
}

function processStatsIncrementalMinute(s: any) {
  const serverPingVal = s.ping ?? 0
  const memVal = parseFloat(s.memoryUsed) || 0
  const loggersVal = s.activeLoggers || 0
  const sessionsVal = s.activeSessions || 0
  const pageHitsVal = s.pageHits || 0
  const apiHitsVal = s.apiHits || 0
  const uniqueRequestsVal = s.uniqueRequests || 0
  const dbHitsVal = s.dbHits || 0
  const errorPageHitsVal = s.errorPageHits || 0

  const limit = getTimescaleLimit('1m')
  updateHistoryField(historyPing, 'ping', serverPingVal, limit)
  updateHistoryField(historyMemory, 'memory', memVal, limit)
  updateHistoryField(historyLoggers, 'loggers', loggersVal, limit)
  updateHistoryField(historySessions, 'sessions', sessionsVal, limit)
  updateHistoryField(historyPageHits, 'pageHits', pageHitsVal, limit)
  updateHistoryField(historyApiHits, 'apiHits', apiHitsVal, limit)
  updateHistoryField(
    historyUniqueRequests,
    'uniqueRequests',
    uniqueRequestsVal,
    limit,
  )
  updateHistoryField(historyDbHits, 'dbHits', dbHitsVal, limit)
  updateHistoryField(
    historyErrorPageHits,
    'errorPageHits',
    errorPageHitsVal,
    limit,
  )

  if (s.latestHistoryPoint?.timestamp) {
    lastProcessedHistoryTimestamp = s.latestHistoryPoint.timestamp
  }

  drawAllSparklines()
}

function processStatsIncrementalStandard(s: any) {
  const lp = s.latestHistoryPoint
  if (lp && lp.timestamp > lastProcessedHistoryTimestamp) {
    const limit = getTimescaleLimit(activeTimescale)
    updateHistoryField(historyPing, 'ping', lp.ping || 0, limit)
    updateHistoryField(historyMemory, 'memory', lp.memoryUsed, limit)
    updateHistoryField(historyLoggers, 'loggers', lp.activeLoggers, limit)
    updateHistoryField(historySessions, 'sessions', lp.activeSessions, limit)
    updateHistoryField(historyPageHits, 'pageHits', lp.pageHits || 0, limit)
    updateHistoryField(historyApiHits, 'apiHits', lp.apiHits || 0, limit)
    updateHistoryField(
      historyUniqueRequests,
      'uniqueRequests',
      lp.uniqueRequests || 0,
      limit,
    )
    updateHistoryField(historyDbHits, 'dbHits', lp.dbHits || 0, limit)
    updateHistoryField(
      historyErrorPageHits,
      'errorPageHits',
      lp.errorPageHits || 0,
      limit,
    )

    lastProcessedHistoryTimestamp = lp.timestamp
    drawAllSparklines()
  }
}

function updateTopPagesList(topPages: any[]) {
  const topPagesListContainer = document.getElementById(
    'top-pages-list-container',
  )
  if (!topPagesListContainer) return

  activeTopPagesProgressBars.forEach(bar => {
    bar.destroy()
  })
  activeTopPagesProgressBars = []

  if (topPages.length === 0) {
    topPagesListContainer.innerHTML =
      '<div class="results-empty"><span>No page hits recorded for this period.</span></div>'
    return
  }

  const maxHits = Math.max(...topPages.map((p: any) => p.hits), 1)
  let html = `
    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
      <div style="display: grid; grid-template-columns: 1fr auto; font-weight: 600; font-size: 0.8rem; color: var(--text-muted); border-bottom: 1px solid var(--border-color); padding-bottom: 0.5rem;">
        <span>Page Path</span>
        <span style="text-align: right; min-width: 80px;">Hits</span>
      </div>
  `

  topPages.forEach((p: any) => {
    const percent = Math.round((p.hits / maxHits) * 100)
    html += `
      <div style="display: grid; grid-template-columns: 1fr auto; align-items: center; font-size: 0.85rem; padding: 0.25rem 0;">
        <div style="display: flex; flex-direction: column; gap: 0.4rem; overflow: hidden; padding-right: 1rem;">
          <span style="font-family: var(--font-mono); color: var(--text-main); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHTML(p.page)}</span>
          <div class="segmented-progress-bar-pages" data-percent="${percent}"></div>
        </div>
        <span style="text-align: right; font-weight: 600; font-family: var(--font-mono); color: var(--text-main); min-width: 80px;">${p.hits.toLocaleString()}</span>
      </div>
    `
  })

  html += '</div>'
  topPagesListContainer.innerHTML = html

  topPagesListContainer
    .querySelectorAll('.segmented-progress-bar-pages')
    .forEach((el: any) => {
      const pct = parseFloat(el.getAttribute('data-percent') || '0')
      activeTopPagesProgressBars.push(new SegmentedProgress(el, pct))
    })
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
  activeTimescale = newTimescale

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
  const subTexts: Record<string, string> = {
    'canvas-ping': 'Server self-check ping latency',
    'canvas-memory': 'Heap/RSS RAM consumption',
    'canvas-loggers': 'Active client logger tunnels',
    'canvas-sessions': 'In-memory active user sessions',
    'canvas-route-hits': 'Application page requests',
    'canvas-api-hits': 'API endpoint requests',
    'canvas-unique-requests': 'Distinct request signatures',
    'canvas-db-hits': 'Database query executions',
    'canvas-error-page-hits': 'Custom error page renders',
  }
  for (const [canvasId, baseText] of Object.entries(subTexts)) {
    const canvas = document.getElementById(canvasId)
    const card = canvas?.closest('.chart-card')
    const subEl = card?.querySelector('.card-sub')
    if (subEl) {
      subEl.textContent = `${baseText} ${labelMap[newTimescale]}`
    }
  }

  historyPing.length = 0
  historyMemory.length = 0
  historyLoggers.length = 0
  historySessions.length = 0
  historyPageHits.length = 0
  historyApiHits.length = 0
  historyUniqueRequests.length = 0
  historyDbHits.length = 0
  historyErrorPageHits.length = 0

  for (const key in trackers) {
    trackers[key] = { min: Infinity, max: -Infinity, sum: 0, count: 0 }
    const minEl = document.getElementById(`${key}-min`)
    const maxEl = document.getElementById(`${key}-max`)
    const avgEl = document.getElementById(`${key}-avg`)
    if (minEl) minEl.innerText = '-'
    if (maxEl) maxEl.innerText = '-'
    if (avgEl) avgEl.innerText = '-'
  }

  lastProcessedHistoryTimestamp = 0
  drawAllSparklines()
  loadStats(true)
}
