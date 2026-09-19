/**
 * The sparkline tooltip: the element, what it says, and when it is shown.
 *
 * Split out of `stats.ts`. Everything here creates or positions DOM;
 * `sparkline.ts` next door owns the canvas and the geometry, and this file
 * depends on it in one direction only.
 */

import { activeTimescale, METRICS, type Metric } from './metrics'
import {
  drawSparkline,
  resolveHoverPoint,
  sparklineHoverStates,
} from './sparkline'

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

  const point = resolveHoverPoint(config.canvas, data, rect)
  if (!point) {
    tooltip.classList.remove('visible')
    return
  }

  tooltip.textContent = `${formatSparklineTooltipValue(point.value, config.unit)} (${formatSparklineAge(point.index, data.length)})`
  tooltip.dataset.placement = point.y < 28 ? 'below' : 'above'
  tooltip.style.left = `${rect.left - chartRect.left + point.x}px`
  tooltip.style.top = `${rect.top - chartRect.top + point.y}px`
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
      // The marker is painted *into* the canvas, so it only moves when the
      // canvas is repainted. Without this it would lag the pointer by up to a
      // second — the polling redraw's interval — and read as a stuck dot.
      drawSparkline(config.canvas, config.history, config.stroke, config.fill)
    })

    canvas.addEventListener('pointerleave', () => {
      state.visible = false
      const tooltip = ensureSparklineTooltip(canvas)
      if (tooltip) tooltip.classList.remove('visible')
      // Repaint to clear the marker, for the same reason.
      drawSparkline(config.canvas, config.history, config.stroke, config.fill)
    })
  }

  window.addEventListener('resize', refreshSparklineTooltips, {
    passive: true,
  })
  window.addEventListener('scroll', refreshSparklineTooltips, {
    passive: true,
  })
}
