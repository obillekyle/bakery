import { afterEach, describe, expect, test } from 'bun:test'
// Side effect, and it must come first: `core/init` binds the JSX globals
// (`createElement`, `Fragment`) that the classic runtime resolves in global
// scope. Without it, rendering any component here is a ReferenceError.
import '@bakery-framework/core/core/init'
import { Bakery } from '@bakery-framework/core/core/bakery'
import Dashboard from './shell'

/**
 * The console's Database entry is a way *out* of the console — the explorer owns
 * row editing now. Whether it is a link or a tab depends on whether anything
 * declares the `/_db` namespace (`Handler.namespace`), which the shell reads
 * from the registry rather than by importing db-explorer: a plugin-to-plugin
 * import is a package-graph edge and `tests/conventions.test.ts` allows
 * exactly one (dashboard → analytics).
 *
 * These fixtures used to *behave* like the handlers they stand for — the shell
 * probed `canHandle('/_db')` against a control path — and now they *declare*,
 * because that is what the shell reads. The cases keep their old names on
 * purpose: each one pins the same question as before, asked of the declaration
 * instead of the behaviour.
 */

class ExplorerLike {
  static namespace = '/_db'
  static canHandle(path: string) {
    return path === '/_db' || path.startsWith('/_db/')
  }
}

/**
 * The priority-0 fallback: claims every path behaviourally and declares no
 * namespace — which is precisely why the declaration mechanism exists. Under
 * the old probe this needed a control path to exclude; now it is excluded by
 * saying nothing.
 */
class CatchAll {
  static namespace = null
  static canHandle() {
    return true
  }
}

/** A handler that reads the request; its declaration is null like most. */
class NeedsRequest {
  static namespace = null
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
   * The case the old probe needed a control path for.
   *
   * `StaticHandler.canHandle()` returns `true` unconditionally — it is the
   * priority-0 fallback and claims everything — so any *behavioural* "does
   * something claim `/_db`" is always yes. Under the declaration it is
   * excluded by declaring nothing, and this pins that a registered catch-all
   * still does not put the link in the nav.
   */
  test('a catch-all handler does not count as an explorer', () => {
    register(CatchAll, 0)
    const html = render()

    expect(html).not.toContain('<a class="tab-btn" href="/_db"')
    expect(html).toContain('id="panel-database"')
  })

  test('a handler that needs the request is skipped, not fatal', () => {
    // Under the probe this guarded against `canHandle` *throwing* on a
    // path-only call. The declaration is a property read and cannot throw, so
    // what is left to pin is that such a handler simply does not count.
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
