import { describe, expect, test } from 'bun:test'
import { TIMESCALES } from '@bakery-framework/plugin-analytics/timescale'
import {
  getTimescaleIntervalMs,
  getTimescaleLimit,
  TIMESCALE_SHAPE,
} from './parts/metrics'

/**
 * The console client keeps its own copy of the timescale table, and this is
 * what keeps the two honest.
 *
 * The duplication is deliberate. `analytics/src/timescale.ts` is the one
 * source for the server, and importing it from the browser client *compiles* —
 * tsconfig paths resolve it — but does not run: the client is bundled and
 * served as a classic `<script>`, so a cross-package specifier survives as a
 * bare `import` the page cannot execute, and the whole console silently does
 * nothing.
 *
 * That is exactly what happened. `Bun.build` reported success, the file was
 * served 200 at the right length, typecheck passed and the suite passed,
 * because nothing requested the page. A test can cross the boundary the
 * bundle cannot, so the copies agree by assertion rather than by luck — which
 * is the part of collapsing the five original tables that survives here.
 */
describe('the browser copy of the timescale table', () => {
  test('names exactly the timescales the server does', () => {
    expect(Object.keys(TIMESCALE_SHAPE).sort()).toEqual(
      Object.keys(TIMESCALES).sort(),
    )
  })

  test('agrees on every window and point count', () => {
    for (const [key, shape] of Object.entries(TIMESCALE_SHAPE)) {
      const server = TIMESCALES[key as keyof typeof TIMESCALES]
      expect(shape.windowMs).toBe(server.windowMs)
      expect(shape.points).toBe(server.points)
    }
  })

  test('derives the same bucket and limit the server does', () => {
    for (const key of Object.keys(TIMESCALE_SHAPE)) {
      const server = TIMESCALES[key as keyof typeof TIMESCALES]
      expect(getTimescaleIntervalMs(key)).toBe(server.bucketMs)
      expect(getTimescaleLimit(key)).toBe(server.points)
    }
  })

  test('falls back to the narrowest window, as the server does', () => {
    expect(getTimescaleIntervalMs('1y')).toBe(TIMESCALES['1m'].bucketMs)
    expect(getTimescaleLimit('1y')).toBe(TIMESCALES['1m'].points)
  })
})
