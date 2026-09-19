/**
 * What the console charts are, and the state that says how they are being
 * shown.
 *
 * Split out of `stats.ts`, which was 999 lines holding four separate jobs: this
 * catalogue, the canvas drawing, the tooltip DOM, and the live feed that drives
 * all three. Nothing here touches a canvas or a socket, which is what makes it
 * the piece the other three can each depend on without depending on each other.
 */

import { setText } from './utils'

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
export interface Metric {
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

export const METRIC_BY_KEY = new Map(METRICS.map(m => [m.key, m]))

/** The "have we loaded any history yet" probe; every metric fills together. */
export const memoryHistory = METRIC_BY_KEY.get('memory')!.history

/** A history point's value for this metric. */
export function readPoint(m: Metric, point: any): number {
  return m.zero ? point[m.field] || 0 : point[m.field]
}

/** The live per-second payload's value for this metric. */
export function readLive(m: Metric, s: any): number {
  return m.live ? m.live(s) : s[m.field] || 0
}

/**
 * Which window the charts are showing.
 *
 * Here rather than in `stats.ts` because two modules read it — the live feed
 * and the tooltip's age labels — and only one writes it. An `export let`
 * cannot be assigned from outside the module that declares it, so the write
 * goes through `setActiveTimescale` and every reader still sees the live
 * binding.
 */
export let activeTimescale = '1m'

export function setActiveTimescale(next: string): void {
  activeTimescale = next
}

/**
 * The timescale shape, as the browser sees it.
 *
 * **This is a second copy of `analytics/src/timescale.ts`, and it has to be.**
 * That module is the one source for the server, and importing it here compiles
 * — `tsconfig` paths resolve it — but does not *run*: this file is bundled for
 * the browser and served as a classic `<script>`, so a cross-package specifier
 * survives as a bare `import` that the page cannot execute. It took the whole
 * console down silently, because `Bun.build` reports success and nothing
 * requested the page.
 *
 * So the duplication is deliberate and the agreement is a test rather than a
 * hope: `timescale-agreement.test.ts` imports both and fails if they diverge.
 * That is most of what collapsing the five original copies bought, and it is
 * the part that survives a boundary the bundler genuinely cannot cross.
 *
 * Same derivation as the other side: a bucket is the window divided by the
 * points, and a sample is a second of the bucket.
 */
const DAY_MS = 86_400_000

export const TIMESCALE_SHAPE: Record<
  string,
  { windowMs: number; points: number }
> = {
  '1m': { windowMs: 60_000, points: 60 },
  '1h': { windowMs: 3_600_000, points: 60 },
  '1d': { windowMs: DAY_MS, points: 48 },
  '7d': { windowMs: 7 * DAY_MS, points: 28 },
  '30d': { windowMs: 30 * DAY_MS, points: 30 },
}

/** Unknown falls back to the narrowest window, as the server's copy does. */
function shapeOf(timescale: string) {
  return TIMESCALE_SHAPE[timescale] ?? TIMESCALE_SHAPE['1m']!
}

/** How much time one chart point covers. */
export function getTimescaleIntervalMs(timescale: string): number {
  const { windowMs, points } = shapeOf(timescale)
  return windowMs / points
}

/** How many points a timescale is drawn as. See `TIMESCALE_SHAPE`. */
export function getTimescaleLimit(timescale: string): number {
  return shapeOf(timescale).points
}

export interface Tracker {
  min: number
  max: number
  sum: number
  count: number
}

export function emptyTracker(): Tracker {
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
