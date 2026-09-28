import { describe, expect, test } from 'bun:test'
import {
  isTimescale,
  TICK_MS,
  TIMESCALE_KEYS,
  TIMESCALES,
  timescaleFacts,
  timescaleToMs,
} from './timescale'

/**
 * There were five copies of this table across two packages: `timescaleToMs`,
 * `getHistoryLimitForTimescale`, the bucket counts inside
 * `pushAnalyticsSnapshot`, and `getTimescaleIntervalMs` / `getTimescaleLimit`
 * in the dashboard's client, the last pair byte-identical to the second.
 *
 * They agreed, which is luck rather than design, because nothing made them.
 * The values below are the ones all five carried, asserted here as literals so
 * that collapsing them into one derivation cannot have moved any of them
 * quietly.
 */
const AS_SHIPPED = {
  '1m': { windowMs: 60_000, points: 60, bucketMs: 1_000, samples: 1 },
  '1h': { windowMs: 3_600_000, points: 60, bucketMs: 60_000, samples: 60 },
  '1d': { windowMs: 86_400_000, points: 48, bucketMs: 1_800_000, samples: 1800 },
  '7d': {
    windowMs: 604_800_000,
    points: 28,
    bucketMs: 21_600_000,
    samples: 21_600,
  },
  '30d': {
    windowMs: 2_592_000_000,
    points: 30,
    bucketMs: 86_400_000,
    samples: 86_400,
  },
} as const

describe('the timescale table', () => {
  test('every value is the one the five copies carried', () => {
    for (const [key, expected] of Object.entries(AS_SHIPPED)) {
      expect(TIMESCALES[key as keyof typeof AS_SHIPPED]).toEqual(expected)
    }
  })

  test('a bucket is the window divided by the points', () => {
    // The relationship the collapse rests on. If a future timescale is added
    // whose numbers do not satisfy it, the table is the wrong shape for it.
    for (const key of TIMESCALE_KEYS) {
      const facts = TIMESCALES[key]
      expect(facts.bucketMs).toBe(facts.windowMs / facts.points)
      expect(Number.isInteger(facts.bucketMs)).toBe(true)
    }
  })

  test('a bucket is a whole number of one-second samples', () => {
    for (const key of TIMESCALE_KEYS) {
      const facts = TIMESCALES[key]
      expect(facts.samples).toBe(facts.bucketMs / TICK_MS)
      expect(Number.isInteger(facts.samples)).toBe(true)
      expect(facts.samples).toBeGreaterThan(0)
    }
  })

  test('the windows are strictly increasing, in the order offered', () => {
    expect(TIMESCALE_KEYS).toEqual(['1m', '1h', '1d', '7d', '30d'])
    for (let i = 1; i < TIMESCALE_KEYS.length; i++) {
      expect(TIMESCALES[TIMESCALE_KEYS[i]!].windowMs).toBeGreaterThan(
        TIMESCALES[TIMESCALE_KEYS[i - 1]!].windowMs,
      )
    }
  })

  test('an unknown timescale falls back to the narrowest window', () => {
    // The value arrives from a query parameter and a socket frame, both
    // client-written, so this must not throw. The narrowest is the safe
    // default: it reads the least data and shows the least.
    expect(isTimescale('1y')).toBe(false)
    expect(timescaleFacts('1y')).toBe(TIMESCALES['1m'])
    expect(timescaleFacts('')).toBe(TIMESCALES['1m'])
  })

  test('timescaleToMs still answers zero for an unknown one', () => {
    // Unchanged from the function this replaced, and `storage-sqlite.ts`
    // reads that zero as "no bound".
    expect(timescaleToMs('1d')).toBe(86_400_000)
    expect(timescaleToMs('nonsense')).toBe(0)
    expect(timescaleToMs('')).toBe(0)
  })

  test('the table cannot be edited by a caller', () => {
    expect(Object.isFrozen(TIMESCALES)).toBe(true)
  })
})
