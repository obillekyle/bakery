/**
 * Every timescale fact, in one place, derived from two numbers each.
 *
 * There were **five** of these tables across two packages, and they agreed,
 * which is luck rather than design, because nothing made them. `timescaleToMs`
 * here, `getHistoryLimitForTimescale` in `core.ts`, the bucket counts inside
 * `pushAnalyticsSnapshot`, and `getTimescaleIntervalMs` / `getTimescaleLimit`
 * in the dashboard's client, the last pair byte-identical to the second.
 *
 * Collapsing them turned up that the whole family follows from a window length
 * and a point count. Checked against all five originals before this replaced
 * them, and `timescale.test.ts` keeps checking:
 *
 *     bucketMs   = windowMs / points
 *     samples    = bucketMs / TICK_MS
 *
 * So `1d` is a day shown as 48 points, which makes each point half an hour and
 * each half hour 1,800 one-second samples, and those are exactly the numbers
 * the five tables carried.
 */

/** One sample per second is what every `history1m` window assumes. */
export const TICK_MS = 1000

export type Timescale = '1m' | '1h' | '1d' | '7d' | '30d'

const DAY_MS = 86_400_000

/** Window length and how many points it is drawn as. Everything else derives. */
const SHAPE: Record<Timescale, { windowMs: number; points: number }> = {
  '1m': { windowMs: 60_000, points: 60 },
  '1h': { windowMs: 3_600_000, points: 60 },
  '1d': { windowMs: DAY_MS, points: 48 },
  '7d': { windowMs: 7 * DAY_MS, points: 28 },
  '30d': { windowMs: 30 * DAY_MS, points: 30 },
}

export interface TimescaleFacts {
  /** How far back the window reaches. */
  windowMs: number
  /** How many points it is drawn as, and how many the history array keeps. */
  points: number
  /** How much time one point covers. */
  bucketMs: number
  /** How many one-second samples fold into one point. */
  samples: number
}

export const TIMESCALES: Record<Timescale, TimescaleFacts> = Object.freeze(
  Object.fromEntries(
    Object.entries(SHAPE).map(([key, { windowMs, points }]) => [
      key,
      {
        windowMs,
        points,
        bucketMs: windowMs / points,
        samples: windowMs / points / TICK_MS,
      },
    ]),
  ),
) as Record<Timescale, TimescaleFacts>

/** The ordered list, for anything that offers a choice of them. */
export const TIMESCALE_KEYS = Object.keys(SHAPE) as Timescale[]

export function isTimescale(value: string): value is Timescale {
  return value in SHAPE
}

/**
 * Facts for a timescale, or `1m`'s.
 *
 * A default rather than a throw, because the value reaches here from a query
 * parameter and a socket frame: both of which a client writes, and neither of
 * which should be able to raise a 500. The narrowest window is the safe one to
 * fall back to: it reads the least data and shows the least.
 */
export function timescaleFacts(timescale: string): TimescaleFacts {
  return isTimescale(timescale) ? TIMESCALES[timescale] : TIMESCALES['1m']
}

/**
 * How far back a timescale reaches, in milliseconds.
 *
 * `0` for an unknown one, which is what this answered before and what
 * `storage-sqlite.ts` relies on to mean "no bound".
 */
export function timescaleToMs(timescale: string): number {
  return isTimescale(timescale) ? TIMESCALES[timescale].windowMs : 0
}
