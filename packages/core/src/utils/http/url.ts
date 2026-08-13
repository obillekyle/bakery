/**
 * The request's parsed URL, parsed at most once.
 *
 * Why memoize at all: `new URL` measures ~1.7µs, and the router, the body
 * parser and the proxy handler all want the same parse of the same request —
 * so the parse was hoisted into the server's `fetch` and shared (see the
 * comment at `packages/cli/src/worker.ts:146-147`).
 *
 * Why a `WeakMap` rather than the property it replaces. The memo used to be
 * `(req as any).__parsedUrl`: two writers, six readers across three packages,
 * every reader spelled `(req as any).__parsedUrl || new URL(req.url)` so that
 * it silently re-parsed whenever the writer had not run first. That is a
 * writer/reader ordering hazard with no way to observe it going wrong — a
 * missed write costs microseconds, not correctness, so nothing ever fails.
 * One function collapses both roles: there is no ordering left to get wrong,
 * no `any` cast anywhere, and no writer to forget. The map also keeps the
 * framework from mutating a `Request` object it does not own — a caller's
 * `Request` goes in and comes back unchanged — and holds its keys weakly, so
 * an entry dies with the request rather than needing eviction (convention 6).
 *
 * There is deliberately no setter. Nothing outside this module needs to say
 * what a request's URL is; `req.url` already does.
 */

const cache = new WeakMap<Request, URL>()

/** The parsed `req.url`, cached per request. */
export function parsedUrl(req: Request): URL {
  const cached = cache.get(req)
  if (cached) return cached

  const url = new URL(req.url)
  cache.set(req, url)
  return url
}
