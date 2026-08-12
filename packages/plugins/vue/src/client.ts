/**
 * `defineLayout()` — browser-side navigation for catch-all pages.
 *
 * A catch-all page (`[...slug].vue`, `[...slug!].vue`) owns every URL under
 * its directory: whatever the path, the server serves the same file. That
 * invariant is what makes client-side navigation *safe* here — swapping
 * content on a URL change can never disagree with what a hard reload would
 * serve — and it is why this API is only available on catch-all pages: on any
 * other page, two URLs mean two different files, and intercepting the
 * navigation would show the wrong one. The server stamps the route's shape
 * into `globalThis.__vue_route`; `defineLayout()` throws without it.
 *
 * The page becomes its subtree's layout: it reads `segments` and renders
 * whichever of its own components the path means — no `<slot />`, no extra
 * file. Clicks on same-origin links under the base are intercepted and become
 * a `pushState` plus a reactive update; links that leave the base navigate
 * normally; back/forward is handled the same way, falling back to a real
 * navigation when history leaves the subtree.
 *
 * Imported from `@bakery-framework/plugin-vue/client`, which the browser
 * resolves through the import map like any installed package. `vue` stays a
 * bare import, so this shares the page's Vue instance.
 */
import { type Ref, ref } from 'vue'

/** What the server stamps on the page — see `handleHtml` in `handler.ts`. */
type StampedRoute = {
  catchAll: boolean
  /** URL prefix owned by the page: '' for a root catch-all, else '/admin'. */
  base: string
  /** The catch-all's param name (`slug` in `[...slug!]`). */
  param: string | null
  /**
   * First path segments the catch-all's *siblings* claim — `faculty` when
   * `faculty/[id].vue` sits beside the catch-all. Those URLs belong to more
   * specific routes, so they get real navigations, not soft ones.
   */
  claimed?: string[]
  /** True when a `[param]` sibling claims every single-segment path. */
  claimedSingle?: boolean
}

export type LayoutNavigation = {
  /** Path segments under the base — `[]` on the bare directory. */
  readonly segments: Ref<string[]>
  /** The URL prefix this page owns. */
  readonly base: string
  /** Navigate within the subtree; segments or a path, `/`-prefixed or not. */
  navigate(to: string | string[]): void
  /**
   * Listen for navigations. Return `false` from a listener to cancel one —
   * cancellation applies to clicks and `navigate()`; back/forward cannot be
   * cancelled, only observed, because the history entry has already moved.
   */
  on(listener: LayoutListener): () => void
}

export type LayoutListener = (
  next: string[],
  prev: string[],
  cause: 'click' | 'navigate' | 'history',
) => boolean | undefined | void

/** Is `path` the base itself or inside it? Prefix-safe: `/admin` ≠ `/admini`. */
export function isUnderBase(base: string, path: string): boolean {
  if (base === '') return path.startsWith('/')
  return path === base || path.startsWith(`${base}/`)
}

/** The segments of `path` below `base` — `[]` for the base itself. */
export function segmentsUnder(base: string, path: string): string[] {
  const rest = base === '' ? path : path.slice(base.length)
  return rest.split('/').filter(Boolean)
}

function pathFor(base: string, to: string | string[]): string {
  if (Array.isArray(to)) {
    const joined = to.filter(Boolean).join('/')
    return joined ? `${base}/${joined}` : base || '/'
  }
  if (to.startsWith('/')) return to
  return to ? `${base}/${to}` : base || '/'
}

export function defineLayout(): LayoutNavigation {
  const route = (globalThis as any).__vue_route as StampedRoute | undefined

  // The guard is the contract, not a formality — see the module comment.
  if (!route?.catchAll) {
    throw new Error(
      'defineLayout() is only available on catch-all pages ' +
        '([...slug].vue or [...slug!].vue): only there does every URL under ' +
        'the page resolve back to the same file on a full load.',
    )
  }

  const base = route.base
  const claimed = new Set(route.claimed ?? [])
  const claimedSingle = Boolean(route.claimedSingle)
  const listeners = new Set<LayoutListener>()

  // The catch-all owns only what nothing else claims. A sibling route under
  // the base — `faculty/[id].vue` beside `[...slug].vue` — wins those URLs on
  // the server, so a soft-nav there would render this page where a hard load
  // renders that one.
  function claimedElsewhere(next: string[]): boolean {
    if (next.length === 1 && claimedSingle) return true
    return next.length > 0 && claimed.has(next[0])
  }

  const initial =
    typeof location !== 'undefined'
      ? segmentsUnder(base, location.pathname)
      : []
  const segments = ref<string[]>(initial)

  function fire(next: string[], cause: Parameters<LayoutListener>[2]): boolean {
    const prev = segments.value
    let allowed = true
    for (const listener of listeners) {
      if (listener(next, prev, cause) === false) allowed = false
    }
    return allowed
  }

  function go(to: string | string[], cause: 'click' | 'navigate'): void {
    const path = pathFor(base, to)
    if (!isUnderBase(base, path)) {
      // Leaving the subtree is a real navigation — the next URL belongs to a
      // different file, and pretending otherwise would render a lie.
      if (typeof location !== 'undefined') location.href = path
      return
    }
    const next = segmentsUnder(base, path)
    if (claimedElsewhere(next)) {
      // Under the base, but a more specific route's territory — real
      // navigation, same reasoning as leaving the base.
      if (typeof location !== 'undefined') location.href = path
      return
    }
    if (!fire(next, cause)) return
    if (typeof history !== 'undefined') history.pushState(null, '', path)
    segments.value = next
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', event => {
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return

      const anchor = (event.target as Element | null)?.closest?.('a[href]')
      if (!anchor) return
      if (anchor.getAttribute('target')) return
      if (anchor.hasAttribute('download')) return

      const href = anchor.getAttribute('href') ?? ''
      // Same-document and external schemes stay the browser's business.
      if (href.startsWith('#')) return
      const url = new URL(href, location.href)
      if (url.origin !== location.origin) return
      if (!isUnderBase(base, url.pathname)) return
      if (
        url.pathname === location.pathname &&
        url.search === location.search
      ) {
        event.preventDefault()
        return
      }

      event.preventDefault()
      go(url.pathname + url.search, 'click')
    })

    window.addEventListener('popstate', () => {
      const path = location.pathname
      if (!isUnderBase(base, path)) {
        // History walked out of the subtree; the entry is already current, so
        // the only honest move is loading what that URL actually serves.
        location.reload()
        return
      }
      const next = segmentsUnder(base, path)
      if (claimedElsewhere(next)) {
        location.reload()
        return
      }
      fire(next, 'history') // observable, not cancellable — see `on`
      segments.value = next
    })
  }

  return {
    segments,
    base,
    navigate: to => go(to, 'navigate'),
    on(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
