import { afterEach, describe, expect, test } from 'bun:test'
// Side effect, and it must come first: `core/init` binds the JSX globals
// (`createElement`, `Fragment`) that the classic runtime resolves in global
// scope. Without it, rendering any component here is a ReferenceError.
import '@bakery-framework/core/core/init'
import { Bakery } from '@bakery-framework/core/core/bakery'
import Dashboard from './shell'

/**
 * The console's Database entry is a way *out* of the console — the explorer owns
 * row editing now. Whether it is a link or a tab depends on whether anything is
 * actually serving `/_db`, which the shell asks behaviourally rather than by
 * importing db-explorer: a plugin-to-plugin import is a package-graph edge and
 * `tests/conventions.test.ts` allows exactly one (dashboard → analytics).
 */

class ExplorerLike {
  static canHandle(path: string) {
    return path === '/_db' || path.startsWith('/_db/')
  }
}

/** The priority-0 fallback, which claims every path. This is the trap. */
class CatchAll {
  static canHandle() {
    return true
  }
}

/** A handler that reads the request, so a path-only call throws. */
class NeedsRequest {
  static canHandle(_path: string, req: Request) {
    return req.headers.get('x-thing') === '1'
  }
}

const registered: unknown[] = []

function register(handler: unknown, priority = 50) {
  Bakery.handlers.fetch.set(handler as never, priority)
  registered.push(handler)
}

afterEach(() => {
  for (const handler of registered)
    Bakery.handlers.fetch.delete(handler as never)
  registered.length = 0
})

const render = () => String(Dashboard())

describe('the Database nav entry', () => {
  test('is a link when something serves /_db', () => {
    register(ExplorerLike)
    const html = render()

    expect(html).toContain('<a class="tab-btn" href="/_db"')
    // …and the panel that exists to say "it moved" is not rendered at all:
    // one click of ceremony in front of the thing itself.
    expect(html).not.toContain('id="panel-database"')
  })

  test('is a tab showing the signpost when nothing does', () => {
    const html = render()

    expect(html).toContain('id="panel-database"')
    // `&#39;`, not `'` — JSX escapes attribute values, which is the behaviour
    // worth having and the reason this asserts the rendered form rather than
    // the source form.
    expect(html).toContain('switchTab(&#39;database&#39;)')
  })

  /**
   * The whole reason the probe uses a control path.
   *
   * `StaticHandler.canHandle()` returns `true` unconditionally — it is the
   * priority-0 fallback and claims everything — so "does some handler claim
   * `/_db`" is always yes, and a naive check would render the link on every
   * install whether or not the explorer exists. A handler that claims `/_db`
   * *and declines a path nobody serves* is claiming a namespace.
   */
  test('a catch-all handler does not count as an explorer', () => {
    register(CatchAll, 0)
    const html = render()

    expect(html).not.toContain('<a class="tab-btn" href="/_db"')
    expect(html).toContain('id="panel-database"')
  })

  test('a handler that needs the request is skipped, not fatal', () => {
    // `canHandle` signatures vary; calling one with a path alone can throw.
    // That means "not the handler we are looking for", not an error page.
    register(NeedsRequest)
    expect(() => render()).not.toThrow()
    expect(render()).not.toContain('<a class="tab-btn" href="/_db"')
  })
})

describe('the footer version', () => {
  test('is the framework version, not a literal', () => {
    // It read `v3` — never any version of anything, and hardcoded where an id
    // suggested something would fill it in. Nothing ever did.
    const html = render()

    expect(html).not.toContain('>v3<')
    expect(html).toMatch(/id="rail-version">v\d+\.\d+\.\d+/)
  })
})
