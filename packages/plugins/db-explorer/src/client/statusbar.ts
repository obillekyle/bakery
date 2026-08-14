/**
 * The bar along the bottom: what is on screen, what it cost, what may be done
 * to it.
 *
 * Every database client has one, and it earns its space by answering three
 * questions that otherwise need a round trip through the developer tools: how
 * many rows there really are, how long the server took, and whether this
 * session can write at all. The last one is the reason it exists here — the
 * access level used to be a line of sidebar text that scrolled away.
 *
 * `statusParts` is **pure** and is where the wording lives, so the segments are
 * asserted rather than read off a screenshot.
 */

import { box, el } from './dom'

export interface StatusFacts {
  table: string | null
  totalRows?: number
  page: number
  totalPages?: number
  /** Milliseconds the server reported for the last table-data call. */
  ms: number | null
  access: 'read' | 'write' | false
  dirtyRows: number
  /** Filters currently applied, so a surprising row count has an explanation. */
  filterCount: number
}

/**
 * The segments, in order, already worded.
 *
 * Absent facts are **omitted rather than rendered as a placeholder** — a
 * `page 1 / ?` teaches nobody anything, and `getData` genuinely does not always
 * return a total. An empty array is the honest answer for "nothing is open".
 */
export function statusParts(facts: StatusFacts): string[] {
  if (!facts.table) return []
  const parts: string[] = []

  if (facts.totalRows !== undefined) {
    parts.push(`${formatCount(facts.totalRows)} row${plural(facts.totalRows)}`)
  }
  parts.push(
    facts.totalPages !== undefined
      ? `page ${facts.page} / ${facts.totalPages}`
      : `page ${facts.page}`,
  )
  if (facts.filterCount > 0) {
    parts.push(`${facts.filterCount} filter${plural(facts.filterCount)}`)
  }
  if (facts.ms !== null) parts.push(`${formatMs(facts.ms)} ms`)
  parts.push(accessLabel(facts.access))
  if (facts.dirtyRows > 0) {
    parts.push(`${facts.dirtyRows} unsaved row${plural(facts.dirtyRows)}`)
  }
  return parts
}

function plural(count: number): string {
  return count === 1 ? '' : 's'
}

/** Thousands separated, because a six-figure row count is unreadable without. */
function formatCount(count: number): string {
  return count.toLocaleString('en-US')
}

/**
 * Sub-millisecond timings keep one decimal.
 *
 * `getElapsed` returns a float, and a fast query rounding to `0 ms` reads as
 * "not measured" rather than "fast" — which is the opposite of what it means.
 */
function formatMs(ms: number): string {
  return ms < 10 ? ms.toFixed(1) : String(Math.round(ms))
}

function accessLabel(access: 'read' | 'write' | false): string {
  if (access === 'write') return 'read · write'
  if (access === 'read') return 'read-only'
  return 'no access'
}

export class StatusBar {
  readonly node: HTMLElement
  private readonly line: HTMLElement
  /**
   * The last facts painted.
   *
   * Kept so `bumpDirty` can repaint one segment without the caller having to
   * reconstruct the row count, the page and the timing — which it cannot,
   * since a staged edit does not re-fetch and the alternative would be showing
   * a stale count or none.
   */
  private facts: StatusFacts = {
    table: null,
    page: 1,
    ms: null,
    access: false,
    dirtyRows: 0,
    filterCount: 0,
  }

  constructor() {
    this.line = el('span', { class: 'status-parts' })
    this.node = box('statusbar', this.line)
    this.node.setAttribute('role', 'status')
  }

  paint(facts: StatusFacts): void {
    this.facts = facts
    this.render()
  }

  /** A staged or saved edit. Everything else on the bar is unchanged. */
  bumpDirty(dirtyRows: number): void {
    if (this.facts.dirtyRows === dirtyRows) return
    this.facts = { ...this.facts, dirtyRows }
    this.render()
  }

  private render(): void {
    this.line.textContent = statusParts(this.facts).join(' · ')
    // The dirty count is the one segment worth colouring, and it is always
    // last — so the class goes on the bar rather than on a span nobody can see
    // when the bar is empty.
    this.node.classList.toggle('dirty', this.facts.dirtyRows > 0)
  }
}
