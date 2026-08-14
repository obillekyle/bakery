import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A canvas whose bitmap is sized from its own measured box must have its
 * display size owned by CSS.
 *
 * `drawSparkline` does the standard device-pixel-ratio dance:
 *
 * ```ts no-check — quoted from client/parts/stats.ts
 * const rect = canvas.getBoundingClientRect()
 * canvas.width = Math.trunc(rect.width * dpr)
 * ```
 *
 * That is correct *provided the box does not depend on the attribute it
 * writes*. A canvas with no CSS width lays out at its `width`/`height`
 * attributes — so with only `min-height` declared, the line above read the
 * attribute, multiplied it by the pixel ratio and wrote it back. A feedback
 * loop with gain `dpr`, re-entered once a second by the polling redraw: on a
 * 125% display the nine charts grew 323 → 404 → 505 → 631 px and spilled out
 * of their cards.
 *
 * `dpr === 1` is a fixed point, which is why it never showed on an unscaled
 * screen and why no amount of local clicking would have found it. It was
 * reported from a screenshot.
 *
 * Asserted as a grep because the property lives in a stylesheet, and because
 * the failure is silent: the charts still draw, they are simply the wrong size,
 * and only on some displays.
 */
describe('chart canvases are sized by CSS, not by their own attributes', () => {
  const css = readFileSync(
    join(import.meta.dir, '..', '..', 'public', 'style.css'),
    'utf8',
  )

  /** The declaration block for `.big-chart`, comments stripped. */
  function bigChartRule(): string {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const match = /\.big-chart\s*\{([^}]*)\}/.exec(withoutComments)
    return match?.[1] ?? ''
  }

  test('the rule exists at all', () => {
    // Guards the guard: a renamed class would make every check below vacuous.
    expect(bigChartRule().trim()).not.toBe('')
  })

  test('it declares an explicit width', () => {
    // The one that matters. Without it the box follows the attribute and the
    // resize becomes self-referential.
    expect(bigChartRule()).toMatch(/(^|[\s;])width\s*:/)
  })

  test('it declares an explicit height, not only a minimum', () => {
    // `min-height` alone leaves the height free to follow the attribute in the
    // same way, which is how the charts also grew vertically.
    expect(bigChartRule()).toMatch(/(^|[\s;])height\s*:/)
  })

  test('it is not an inline box', () => {
    // A canvas defaults to `display: inline`, where percentage width does not
    // resolve against the parent the way this needs — and it adds a baseline
    // gap beneath the chart.
    expect(bigChartRule()).toMatch(/display\s*:\s*block/)
  })
})
