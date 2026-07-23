declare const is: any

export class SegmentedProgress {
  private container: HTMLElement
  private percent: number
  private barWidth: number
  private barGap: number
  private resizeObserver: ResizeObserver | null = null

  constructor(
    container: HTMLElement,
    percent: number,
    barWidth = 4,
    barGap = 6,
  ) {
    this.container = container
    this.percent = percent
    this.barWidth = barWidth
    this.barGap = barGap
    this.init()
  }

  private init() {
    this.container.classList.add('segmented-progress-container')
    if (this.barGap !== 6) {
      this.container.style.gap = `${this.barGap}px`
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.draw())
      this.resizeObserver.observe(this.container)
    }

    this.draw()
  }

  public destroy() {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }
  }

  public draw() {
    const containerWidth = this.container.clientWidth
    if (containerWidth === 0) return

    const count = Math.floor(
      (containerWidth + this.barGap) / (this.barWidth + this.barGap),
    )
    const activeCount = Math.round((this.percent / 100) * count)

    let html = ''
    for (let i = 0; i < count; i++) {
      const className = i < activeCount ? 'active' : 'inactive'
      let styleAttr = ''
      if (this.barWidth !== 4) {
        styleAttr = ` style="width: ${this.barWidth}px;"`
      }
      html += `<div class="segmented-bar-segment ${className}"${styleAttr}></div>`
    }
    this.container.innerHTML = html
  }
}

export function getWebSocketUrl(path: string) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${path}`
}

export function formatUptime(totalSeconds: number): string {
  if (totalSeconds < 0) return '0s'
  const hrs = Math.floor(totalSeconds / 3600)
  const mins = Math.floor((totalSeconds % 3600) / 60)
  const secs = Math.floor(totalSeconds % 60)
  const secsStr = `${secs}s`
  if (hrs > 0) return `${hrs}h ${mins}m ${secsStr}`
  if (mins > 0) return `${mins}m ${secsStr}`
  return secsStr
}

const COLOR_MAP: Record<string, string> = {
  r: '#ef4444', // Red
  g: '#10b981', // Green
  y: '#facc15', // Yellow
  b: '#3b82f6', // Blue
  m: '#ec4899', // Magenta
  c: '#06b6d4', // Cyan
  w: '#ffffff', // White
  d: '#9ca3af', // Gray
  B: '#b45309', // Brown
  p: '#8b5cf6', // Purple
  o: '#f97316', // Orange
}

type ColorState = { html: string; inSpan: boolean }

function applyColorToken(state: ColorState, code: string): void {
  if (code === '%') {
    state.html += '%'
  } else if (code === '*' || code === '0') {
    if (state.inSpan) {
      state.html += '</span>'
      state.inSpan = false
    }
  } else if (COLOR_MAP[code]) {
    if (state.inSpan) state.html += '</span>'
    state.html += `<span style="color: ${COLOR_MAP[code]};">`
    state.inSpan = true
  }
}

export function colorizeHtml(msg: string): string {
  const state: ColorState = { html: '', inSpan: false }
  const parts = msg.split(/(%[a-zA-Z0-9*%])/g)

  for (const part of parts) {
    if (part.startsWith('%') && part.length === 2) {
      applyColorToken(state, part[1])
    } else {
      state.html += escapeHTML(part)
    }
  }

  if (state.inSpan) state.html += '</span>'
  return state.html
}
