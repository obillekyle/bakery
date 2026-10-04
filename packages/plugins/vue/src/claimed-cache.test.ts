import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import '@bakery-framework/core/core/init'
import { initConfig } from '@bakery-framework/core/core/config'
import { __resetClaimedCache, claimedBeside } from './handler'
import { withProdFlag } from './tests/mode-flag'

/**
 * `claimedBeside` walks the catch-all's directory and recurses into every
 * sibling directory to ask whether it holds a route file, on every catch-all
 * page request. Measured against trees of an app's shape: 0.48 ms at four
 * directories, 1.24 ms at twelve, 4.44 ms at thirty.
 *
 * In production it cannot change (no watcher, and the `SIGHUP` handler is a
 * deliberate no-op), so it is memoized there and computed per request in
 * development, where a file appearing has to be seen on the next load.
 *
 * Both halves are asserted by *changing the directory underneath it*, which is
 * the only way to tell a reused answer from a recomputed one.
 */
const dirs: string[] = []

function pageDir(): string {
  const root = mkdtempSync(`${tmpdir()}/claimed-`).replace(/\\/g, '/')
  dirs.push(root)
  writeFileSync(`${root}/[...slug].vue`, '<template><div/></template>')
  writeFileSync(`${root}/reports.vue`, '<template><div/></template>')
  mkdirSync(`${root}/admin`)
  writeFileSync(`${root}/admin/index.vue`, '<template><div/></template>')
  return root
}

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetClaimedCache()
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Temp directories; a lingering handle on Windows is not worth failing.
    }
  }
})

describe('sibling claims', () => {
  test('development sees a file that appears', () => {
    // `PROD` is `'1'` in a test process, so development has to be asked for
    // explicitly here. That is also why `__resetClaimedCache` exists: a test
    // that writes into a page directory between two calls is, by default,
    // running against the production behavior.
    withProdFlag(false, () => {
      const root = pageDir()
      const target = `${root}/[...slug].vue`

      const before = claimedBeside(target)
      expect(before.claimed).toContain('reports.vue')
      expect(before.claimed).not.toContain('invoices.vue')

      writeFileSync(`${root}/invoices.vue`, '<template><div/></template>')

      const after = claimedBeside(target)
      expect(after.claimed).toContain('invoices.vue')
    })
  })

  test('production answers from the first walk', () => {
    const root = pageDir()
    const target = `${root}/[...slug].vue`

    withProdFlag(true, () => {
      const before = claimedBeside(target)
      expect(before.claimed).toContain('reports.vue')

      // A file the walk would find, added after the first answer. In
      // production the page tree cannot change without a restart, so not
      // seeing it is the point rather than a defect.
      writeFileSync(`${root}/invoices.vue`, '<template><div/></template>')

      const after = claimedBeside(target)
      expect(after.claimed).not.toContain('invoices.vue')
      // The same object, not merely an equal one.
      expect(after).toBe(before)
    })
  })

  test('each catch-all gets its own entry', () => {
    const one = pageDir()
    const two = pageDir()
    writeFileSync(`${two}/billing.vue`, '<template><div/></template>')

    withProdFlag(true, () => {
      const first = claimedBeside(`${one}/[...slug].vue`)
      const second = claimedBeside(`${two}/[...slug].vue`)

      expect(first.claimed).not.toContain('billing.vue')
      expect(second.claimed).toContain('billing.vue')
    })
  })

  test('an unreadable directory is remembered too', () => {
    // Otherwise the failing walk is retried on every request for the life of
    // the process.
    withProdFlag(true, () => {
      const missing = `${tmpdir()}/does-not-exist-${Math.random()}/[...slug].vue`
      const first = claimedBeside(missing)
      expect(first).toEqual({ claimed: [], claimedSingle: false })
      expect(claimedBeside(missing)).toBe(first)
    })
  })

  test('the extensionless stem is claimed alongside the file', () => {
    // Unchanged behavior, pinned here because the memo now stands between
    // the walk and every caller.
    const root = pageDir()
    const claims = claimedBeside(`${root}/[...slug].vue`)
    expect(claims.claimed).toContain('reports.vue')
    expect(claims.claimed).toContain('reports')
  })
})
