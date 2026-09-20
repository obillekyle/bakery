import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Bakery } from '@bakery-framework/core/core/bakery'
import { initConfig } from '@bakery-framework/core/core/config'
import { Handler } from '@bakery-framework/core/handlers'
import renderDashboardShell, { __resetShellCache } from './shell'

/**
 * The console shell is an 11.8 KB document that is identical on every request
 *: the only thing in it that can change is one nav entry, which depends on
 * whether an explorer is mounted at `/_db`. It was rendered from JSX per
 * request at 0.50 ms a time.
 *
 * The memo is keyed on that one fact rather than held unconditionally, so a
 * registry that changes is followed rather than remembered wrongly. These pin
 * both halves: that it is reused, and that the key works.
 */
class FakeExplorer extends Handler {
  static override readonly namespace = '/_db'
  static override canHandle(): boolean {
    return false
  }
}

beforeAll(async () => {
  await initConfig()
})

afterEach(() => {
  __resetShellCache()
  Bakery.handlers.fetch.delete(FakeExplorer)
})

describe('the console shell is rendered once', () => {
  test('two requests get the same string', () => {
    const first = renderDashboardShell()
    const second = renderDashboardShell()
    expect(String(second)).toBe(String(first))
    // Identity, which is the only observable difference between a reused
    // document and an identical re-rendered one.
    expect(second).toBe(first)
  })

  test('mounting an explorer changes the answer', () => {
    const without = renderDashboardShell()
    // The signpost panel links to `/_db` either way; what changes is the
    // nav entry, a link when mounted and a tab button when not, and whether
    // the signpost panel is rendered at all.
    expect(String(without)).not.toContain('class="tab-btn" href="/_db"')
    expect(String(without)).toContain('id="panel-database"')

    // A second surface declaring the namespace is exactly how the nav learns
    // about it: `shell.tsx` asks the registry's declarations, never imports
    // the explorer.
    Bakery.handlers.fetch.set(FakeExplorer, 10)

    const withExplorer = renderDashboardShell()
    expect(withExplorer).not.toBe(without)
    expect(String(withExplorer)).toContain('class="tab-btn" href="/_db"')
    expect(String(withExplorer)).not.toContain('id="panel-database"')
  })

  test('unmounting it changes the answer back', () => {
    Bakery.handlers.fetch.set(FakeExplorer, 10)
    const mounted = renderDashboardShell()
    expect(String(mounted)).toContain('class="tab-btn" href="/_db"')

    Bakery.handlers.fetch.delete(FakeExplorer)
    const unmounted = renderDashboardShell()
    expect(unmounted).not.toBe(mounted)
    expect(String(unmounted)).not.toContain('class="tab-btn" href="/_db"')
  })

  test('the reused document is the whole document', () => {
    const shell = String(renderDashboardShell())
    expect(shell).toContain('<title>Bakery Console</title>')
    expect(shell).toContain('/_dashboard/dashboard.js')
    expect(shell).toContain('Bakery Console')
    expect(renderDashboardShell()).toBe(renderDashboardShell())
  })
})
