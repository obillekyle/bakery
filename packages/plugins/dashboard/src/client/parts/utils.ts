/**
 * Shared browser-side helpers for the dashboard panels.
 *
 * The panels were built independently and each grew its own copy of the same
 * four things: an element-text setter, a `results-empty` block, a
 * fetch/`.json()` pair, and a prev/next pager. They are declared once here
 * because this file is compiled into the shipped bundle — a duplicated string
 * literal is duplicated bytes, the minifier does not merge them.
 *
 * Shrank when the database editor was retired: `executeAction`, `getJson`,
 * `errorBox` and three icon paths had no caller left once `database.ts` went,
 * and dead code in a browser bundle is bytes every operator downloads.
 */

/** `innerText` on an element that may not be in the DOM yet. */
export function setText(id: string, value: string) {
  const el = document.getElementById(id)
  if (el) el.innerText = value
}

/**
 * The one spelling of the panels' placeholder/error block.
 *
 * `message` is **escaped here**, so a caller cannot leak markup by forgetting.
 * These helpers previously took a string straight into `innerHTML`: every
 * caller happened to pass a literal or escape first, which is exactly the state
 * a codebase is in right before it stops being true. Every XSS found in this
 * repo came from hand-built DOM strings in these panel files, including a
 * stored-XSS to arbitrary-SQL chain through the database grid — which is gone
 * now, but the escaping default it argued for is not, because the sessions and
 * stats panels build markup the same way from data they did not write.
 */
export function emptyBox(message: string, isError = false): string {
  const style = isError ? ' style="color: var(--accent-red);"' : ''
  return `<div class="results-empty"${style}><span>${escapeHTML(message)}</span></div>`
}

export function setEmpty(
  el: HTMLElement | null,
  message: string,
  isError = false,
) {
  if (el) el.innerHTML = emptyBox(message, isError)
}

/**
 * Inline SVGs, built from the path data alone. Every hand-written copy in the
 * panels carried `width="1em" height="1em"` twice — a duplicate attribute the
 * parser silently drops — and the same ~380-byte markup was pasted once per
 * use site.
 */
export function icon(d: string, size: string): string {
  return (
    `<svg style="font-size: ${size};" width="1em" height="1em" ` +
    `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<path fill="currentColor" d="${d}"/></svg>`
  )
}

export const ICON_EDIT =
  'M5 19h1.425L16.2 9.225L14.775 7.8L5 17.575zm-2 2v-4.25L16.2 3.575q.3-.275.663-.425t.762-.15t.775.15t.65.45L20.425 5q.3.275.438.65T21 6.4q0 .4-.137.763t-.438.662L7.25 21zM19 6.4L17.6 5zm-3.525 2.125l-.7-.725L16.2 9.225z'
export const ICON_DELETE =
  'M7 21q-.825 0-1.412-.587T5 19V6H4V4h5V3h6v1h5v2h-1v13q0 .825-.587 1.413T17 21zM17 6H7v13h10zM9 17h2V8H9zm4 0h2V8h-2zM7 6v13z'
/** POST a JSON body to a dashboard endpoint and unwrap the envelope. */
export async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return await res.json()
}

/** Page N of M, with the prev/next buttons disabled at the ends. */
export function setPager(
  ids: { info: string; prev: string; next: string },
  page: number,
  totalPages: number,
) {
  setText(ids.info, `Page ${page} of ${totalPages}`)
  const prevBtn = document.getElementById(ids.prev) as HTMLButtonElement | null
  const nextBtn = document.getElementById(ids.next) as HTMLButtonElement | null
  if (prevBtn) prevBtn.disabled = page <= 1
  if (nextBtn) nextBtn.disabled = page >= totalPages
}

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
  r: '#ef4444',
  g: '#10b981',
  y: '#facc15',
  b: '#3b82f6',
  m: '#ec4899',
  c: '#06b6d4',
  w: '#ffffff',
  d: '#9ca3af',
  B: '#b45309',
  p: '#8b5cf6',
  o: '#f97316',
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
