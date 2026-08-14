import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { frictionFor } from './confirm'

/**
 * The two properties of the browser client that are worth a grep rather than a
 * unit test, because they are properties of *every* module rather than of one.
 */

const CLIENT_DIR = import.meta.dir
const ENTRY = join(CLIENT_DIR, '..', 'client.ts')

/**
 * Comments are stripped before the scan.
 *
 * Not cosmetic: `dom.ts`'s header explains *why* nothing writes `innerHTML`,
 * and a raw text grep flags the explanation as the violation. Stripping first
 * is also the honest reading of the rule — it is about what the code does, and
 * a rule that cannot be described in a comment is a rule nobody will keep.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function clientSources(): { file: string; source: string }[] {
  const files = readdirSync(CLIENT_DIR)
    .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => join(CLIENT_DIR, name))
  return [ENTRY, ...files].map(file => ({
    file,
    source: stripComments(readFileSync(file, 'utf8')),
  }))
}

/**
 * Every value this client renders is a database row — whatever the last writer
 * put there — and the operator's origin owns `/api/_db/rows`. A string reaching
 * the DOM as markup is therefore stored XSS to arbitrary row writes, which is
 * the exact shape of the dashboard grid's defect. `textContent` everywhere is
 * not a style choice, and this is the check that keeps it true.
 */
const FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
]

describe('the client has no markup sink', () => {
  test('it has modules to check at all', () => {
    // Guards the guard: a glob that matched nothing would pass silently.
    expect(clientSources().length).toBeGreaterThan(10)
  })

  for (const sink of FORBIDDEN) {
    test(`no client module writes ${sink}`, () => {
      const offenders = clientSources()
        .filter(entry => entry.source.includes(sink))
        .map(entry => entry.file)
      expect(offenders).toEqual([])
    })
  }
})

/**
 * **Nothing the browser bundle reaches may import `@bakery-framework/*`.**
 *
 * `bundleModule` marks every installed package external
 * (`packages/core/src/compiler/compiler.ts:316`), so a framework import
 * survives into the emitted bundle as a bare specifier. The browser then tries
 * to fetch `@bakery-framework/core/cache/lru` as a URL, fails, and the whole
 * module never executes — the page sits on "loading…" forever.
 *
 * This is worth a grep rather than trust because of *how* it fails. Typecheck
 * passes, every unit test passes, `bun test` is green, and Chrome reports
 * "Failed to fetch dynamically imported module: …/app.js" — naming the entry
 * rather than the import that broke. Two such imports (`Try` and `LRUCache`,
 * both perfectly reasonable-looking) shipped through a full green suite and
 * were only caught by opening the page.
 *
 * `shared/` is included: it is imported by the endpoints *and* compiled into
 * the bundle, so it lives under the stricter of the two rules.
 */
describe('the browser bundle imports nothing from the framework', () => {
  const SHARED_DIR = join(CLIENT_DIR, '..', 'shared')

  function bundledSources(): { file: string; source: string }[] {
    const shared = readdirSync(SHARED_DIR)
      .filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map(name => join(SHARED_DIR, name))
    return [
      ...clientSources(),
      ...shared.map(file => ({
        file,
        source: stripComments(readFileSync(file, 'utf8')),
      })),
    ]
  }

  test('shared modules are in the scan', () => {
    // Guards the guard, again: `shared/` moving would silently empty this.
    expect(bundledSources().length).toBeGreaterThan(14)
  })

  test('no bundled module names a framework package', () => {
    const offenders = bundledSources()
      .filter(entry => /['"]@bakery-framework\//.test(entry.source))
      .map(entry => entry.file.replace(/\\/g, '/').split('/db-explorer/').pop())
    expect(offenders).toEqual([])
  })
})

/**
 * The friction ladder is policy — the answer to "how bad is this if it was a
 * mis-click" — so it is asserted rather than left inside a click handler.
 */
describe('frictionFor', () => {
  test('one row is immediate, because it has an undo', () => {
    expect(frictionFor(0)).toBe('immediate')
    expect(frictionFor(1)).toBe('immediate')
  })

  test('two to a hundred asks', () => {
    expect(frictionFor(2)).toBe('confirm')
    expect(frictionFor(100)).toBe('confirm')
  })

  test('a hundred and one to ten thousand asks and makes you type the name', () => {
    expect(frictionFor(101)).toBe('typed')
    expect(frictionFor(10_000)).toBe('typed')
  })

  test('past ten thousand is refused, not confirmed', () => {
    // There is no phrasing of "are you sure" that makes an unreviewed
    // ten-thousand-row write a good idea; the answer is a narrower filter.
    expect(frictionFor(10_001)).toBe('refuse')
    expect(frictionFor(1e9)).toBe('refuse')
  })

  test('an indeterminate count does not fall through to the top rung', () => {
    expect(frictionFor(Number.NaN)).toBe('immediate')
  })
})
