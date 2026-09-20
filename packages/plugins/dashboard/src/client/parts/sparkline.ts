/**
 * Drawing a sparkline, and the geometry that goes with it.
 *
 * Split out of `stats.ts`. The seam between this file and
 * `sparkline-tooltip.ts` is **geometry against DOM**: everything here answers
 * "where on the canvas", and nothing here creates or positions an element. The
 * split runs that way because `drawSparkline` needs the hovered point in order
 * to mark it, so a seam drawn around "hover" instead would have put the two
 * files in a cycle.
 */

import { activeTimescale, getTimescaleLimit, METRICS } from './metrics'

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

export function getSparklineScale(dataPoints: number[]) {
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

export interface SparklineHoverState {
  visible: boolean
  clientX: number
  clientY: number
}

export const sparklineHoverStates: Record<string, SparklineHoverState> = {}

export interface HoverPoint {
  index: number
  value: number
  /** Where the point sits on the canvas, in CSS pixels within its box. */
  x: number
  y: number
}

/**
 * Which sample the pointer is over, and where that sample is drawn.
 *
 * Shared by the two things that must agree about it: the marker painted on the
 * canvas and the tooltip positioned over the card. This arithmetic: the 50px
 * reserved for the axis labels, the 24 and 12 of vertical padding, and the
 * `L - M` offset for a series shorter than the window: used to live only in
 * the tooltip. Copying it into the draw path would have worked exactly until
 * one copy was adjusted, at which point the dot and its label would point at
 * different samples and look like a rounding bug.
 */
export function resolveHoverPoint(
  canvasId: string,
  data: number[],
  rect: { left: number; width: number; height: number },
): HoverPoint | null {
  const state = sparklineHoverStates[canvasId]
  if (!state?.visible || data.length === 0) return null

  const { min, max, range } = getSparklineScale(data)
  const graphWidth = Math.max(rect.width - 50, 1)
  const graphHeight = Math.max(rect.height - 24, 1)
  const localX = Math.min(Math.max(state.clientX - rect.left, 0), graphWidth)

  const L = getTimescaleLimit(activeTimescale)
  const M = data.length
  const j = L === 1 ? 0 : Math.round((localX / graphWidth) * (L - 1))
  const index = j - (L - M)
  if (index < 0 || index >= M) return null

  const value = data[index]
  if (value === null || value === undefined || Number.isNaN(value)) return null

  const safeValue = Math.max(min, Math.min(value, max))
  return {
    index,
    value,
    x: L === 1 ? 0 : (j / (L - 1)) * graphWidth,
    y: rect.height - 12 - ((safeValue - min) / range) * graphHeight,
  }
}

/**
 * The hover marker: a guide line down the chart and a ringed dot on the sample.
 *
 * The ring is drawn in the card's own background rather than left transparent,
 * so the dot reads as sitting *on* the line instead of merging into it wherever
 * the series is dense.
 */
export function drawHoverMarker(
  ctx: CanvasRenderingContext2D,
  point: HoverPoint,
  height: number,
  color: string,
) {
  ctx.save()

  ctx.beginPath()
  ctx.moveTo(point.x, 8)
  ctx.lineTo(point.x, height - 10)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.35)'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.stroke()
  ctx.setLineDash([])

  ctx.beginPath()
  ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.lineWidth = 2
  ctx.strokeStyle = 'rgba(15, 17, 21, 0.9)'
  ctx.stroke()

  ctx.restore()
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

  // Last, so the marker sits above the fill rather than under it.
  const hovered = resolveHoverPoint(canvasId, dataPoints, {
    left: rect.left,
    width,
    height,
  })
  if (hovered) drawHoverMarker(ctx, hovered, height, colorStart)
}

export function drawAllSparklines() {
  for (const m of METRICS) {
    drawSparkline(m.canvas, m.history, m.stroke, m.fill)
  }
}
