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

/**
 * The card labels are `<span>`s, and a span is inline.
 *
 * Inside `.card` they stacked anyway, because that rule is
 * `display: flex; flex-direction: column` and a flex container blockifies its
 * children. The labels themselves never claimed to be blocks — so in
 * `.chart-card`, an ordinary block, the same two spans shared a line and every
 * chart read
 * `PING LATENCY HISTORYClient-to-server connection latency (last 1 min…)`.
 *
 * Stated on the labels rather than by making `.chart-card` another flex column:
 * the property belongs to "this is a caption on its own line", not to the two
 * containers that happen to remember to be flex today.
 *
 * A grep again, and for the same reason as above — it renders, it is just
 * wrong, so nothing fails.
 */
describe('card labels are block-level in their own right', () => {
  const css = readFileSync(
    join(import.meta.dir, '..', '..', 'public', 'style.css'),
    'utf8',
  )

  /**
   * The declaration block for a selector, found by string search.
   *
   * Deliberately not a constructed `RegExp`: the selector begins with `.`, so
   * building a pattern from it means escaping, and an escaping mistake here
   * fails by matching *nothing* — which reads exactly like the rule being
   * absent, i.e. like the bug this file exists to catch.
   */
  function rule(selector: string): string {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    // Line-anchored, so `.foo .card-title { … }` cannot answer for `.card-title`.
    const at = withoutComments.indexOf(`\n${selector} {`)
    if (at === -1) return ''
    const open = withoutComments.indexOf('{', at)
    const close = withoutComments.indexOf('}', open)
    return close === -1 ? '' : withoutComments.slice(open + 1, close)
  }

  test.each([
    '.card-title',
    '.card-sub',
  ])('%s does not rely on its parent being a flex column', selector => {
    expect(rule(selector).trim()).not.toBe('')
    expect(rule(selector)).toMatch(/display\s*:\s*block/)
  })
})
