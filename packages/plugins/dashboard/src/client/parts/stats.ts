import {
  formatUptime,
  getWebSocketUrl,
  SegmentedProgress,
  setEmpty,
  setText,
} from './utils'

/**
 * One row per sparkline. The nine metrics were previously written out
 * longhand at seven separate sites — the history arrays, the tracker record,
 * the tooltip configs, `drawAllSparklines`, the two incremental update paths,
 * the full-history path and `changeTimescale` — so adding or renaming one
 * meant seven coordinated edits, and the two update paths had already drifted
 * apart in how they coerce missing values.
 *
 * That drift is preserved deliberately, not flattened: `zero` says whether a
 * history point's missing value reads as `0`, and `live` covers the two
 * metrics whose live payload differs from their history payload (`ping` uses
 * `??`, and `memoryUsed` arrives as a `"12 MB"` string over the socket).
 */
interface Metric {
  /** Tracker key, and the prefix of the `-min` / `-max` / `-avg` element ids. */
  key: string
  /** Canvas element id. */
  canvas: string
  /** `.chart-card` id, for the metrics that blur when analytics is inactive. */
  card?: string
  /** `.card-sub` caption, before the timescale label is appended. */
  sub: string
  /** Property name on a history point and on the live stats payload. */
  field: string
  /** Suffix in the hover tooltip; trimmed for the min/max/avg readout. */
  unit: string
  stroke: string
  fill: string
  /** Whether a missing history value reads as `0`. */
  zero: boolean
  /** Live-payload reader, where it differs from the history reader. */
  live?: (s: any) => number
  history: number[]
}

export const METRICS: Metric[] = [
  {
    key: 'ping',
    canvas: 'canvas-ping',
    sub: 'Server self-check ping latency',
    field: 'ping',
    unit: 'ms',
    stroke: '#f43f5e',
    fill: 'rgba(244, 63, 94, 0.25)',
    zero: true,
    live: s => s.ping ?? 0,
    history: [],
  },
  {
    key: 'memory',
    canvas: 'canvas-memory',
    sub: 'Heap/RSS RAM consumption',
    field: 'memoryUsed',
    unit: ' MB',
    stroke: '#3b82f6',
    fill: 'rgba(59, 130, 246, 0.25)',
    zero: false,
    live: s => parseFloat(s.memoryUsed) || 0,
    history: [],
  },
  {
    key: 'loggers',
    canvas: 'canvas-loggers',
    sub: 'Active client logger tunnels',
    field: 'activeLoggers',
    unit: '',
    stroke: '#10b981',
    fill: 'rgba(16, 185, 129, 0.25)',
    zero: false,
    history: [],
  },
  {
    key: 'sessions',
    canvas: 'canvas-sessions',
    sub: 'In-memory active user sessions',
    field: 'activeSessions',
    unit: '',
    stroke: '#fbbf24',
    fill: 'rgba(251, 191, 36, 0.25)',
    zero: false,
    history: [],
  },
  {
    key: 'pageHits',
    canvas: 'canvas-route-hits',
    card: 'chart-route-hits',
    sub: 'Application page requests',
    field: 'pageHits',
    unit: '',
    stroke: '#06b6d4',
    fill: 'rgba(6, 182, 212, 0.25)',
    zero: true,
    history: [],
  },
  {
    key: 'apiHits',
    canvas: 'canvas-api-hits',
    card: 'chart-api-hits',
    sub: 'API endpoint requests',
    field: 'apiHits',
    unit: '',
    stroke: '#8b5cf6',
    fill: 'rgba(139, 92, 246, 0.25)',
    zero: true,
    history: [],
  },
  {
    key: 'uniqueRequests',
    canvas: 'canvas-unique-requests',
    card: 'chart-unique-requests',
    sub: 'Distinct request signatures',
    field: 'uniqueRequests',
    unit: '',
    stroke: '#f97316',
    fill: 'rgba(249, 115, 22, 0.25)',
    zero: true,
    history: [],
  },
  {
    key: 'dbHits',
    canvas: 'canvas-db-hits',
    card: 'chart-db-hits',
    sub: 'Database query executions',
    field: 'dbHits',
    unit: '',
    stroke: '#a78bfa',
    fill: 'rgba(167, 139, 250, 0.25)',
    zero: true,
    history: [],
  },
  {
    key: 'errorPageHits',
    canvas: 'canvas-error-page-hits',
    card: 'chart-error-page-hits',
    sub: 'Custom error page renders',
    field: 'errorPageHits',
    unit: '',
    stroke: '#ef4444',
    fill: 'rgba(239, 68, 68, 0.25)',
    zero: true,
    history: [],
  },
]

const METRIC_BY_KEY = new Map(METRICS.map(m => [m.key, m]))

/** The "have we loaded any history yet" probe; every metric fills together. */
const memoryHistory = METRIC_BY_KEY.get('memory')!.history

/** A history point's value for this metric. */
function readPoint(m: Metric, point: any): number {
  return m.zero ? point[m.field] || 0 : point[m.field]
}

/** The live per-second payload's value for this metric. */
function readLive(m: Metric, s: any): number {
  return m.live ? m.live(s) : s[m.field] || 0
}

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

function emptyTracker(): Tracker {
  return { min: Infinity, max: -Infinity, sum: 0, count: 0 }
}

export const trackers: Record<string, Tracker> = Object.fromEntries(
  METRICS.map(m => [m.key, emptyTracker()]),
)

export function updateTracker(key: string, val: number) {
  if (val === null || val === undefined || Number.isNaN(val)) return
  const t = trackers[key]
  if (val < t.min) t.min = val
  if (val > t.max) t.max = val
  t.sum += val
  t.count += 1
  const avg = t.sum / t.count

  const suffix = (METRIC_BY_KEY.get(key)?.unit ?? '').trim()
  setText(`${key}-min`, `${t.min.toFixed(0)} ${suffix}`)
  setText(`${key}-max`, `${t.max.toFixed(0)} ${suffix}`)
  setText(`${key}-avg`, `${avg.toFixed(1)} ${suffix}`)
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

  // Assigning to width/height reallocates the backing store and resets the
  // whole context, so the old unconditional resize threw away and rebuilt nine
  // canvases every second even when nothing had moved. Only resize on an
  // actual size change, and set the DPR transform outright rather than
  // relying on the reset to make a cumulative `scale` safe.
  const targetW = Math.trunc(rect.width * dpr)
  const targetH = Math.trunc(rect.height * dpr)
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW
    canvas.height = targetH
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

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

interface SparklineHoverState {
  visible: boolean
  clientX: number
  clientY: number
}

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

export function updateSparklineTooltip(config: Metric) {
  const state = sparklineHoverStates[config.canvas]
  if (!state?.visible) return

  const canvas = document.getElementById(
    config.canvas,
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

  tooltip.textContent = `${formatSparklineTooltipValue(value, config.unit)} (${formatSparklineAge(index, data.length)})`
  tooltip.dataset.placement = pointY < 28 ? 'below' : 'above'
  tooltip.style.left = `${rect.left - chartRect.left + pointX}px`
  tooltip.style.top = `${rect.top - chartRect.top + pointY}px`
  tooltip.classList.add('visible')
}

export function refreshSparklineTooltips() {
  for (const config of METRICS) {
    updateSparklineTooltip(config)
  }
}

export function bindSparklineTooltips() {
  for (const config of METRICS) {
    const canvas = document.getElementById(
      config.canvas,
    ) as HTMLCanvasElement | null
    if (!canvas || canvas.dataset.sparklineTooltipBound === 'true') continue

    canvas.dataset.sparklineTooltipBound = 'true'
    sparklineHoverStates[config.canvas] = {
      visible: false,
      clientX: 0,
      clientY: 0,
    }

    const state = sparklineHoverStates[config.canvas]

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
  for (const m of METRICS) {
    drawSparkline(m.canvas, m.history, m.stroke, m.fill)
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

  activeTopPagesProgressBars.forEach(bar => {
    bar.destroy()
  })
  activeTopPagesProgressBars = []

  if (topPages.length === 0) {
    setEmpty(topPagesListContainer, 'No page hits recorded for this period.')
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
