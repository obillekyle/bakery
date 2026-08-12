/**
 * Shared-credential check for plugin surfaces (`plugin({ credential:
 * import.meta.env.SOME_KEY })`).
 *
 * One implementation, deliberately in core: the db-explorer and analytics
 * plugins each need it and the dashboard's history shows where per-plugin
 * copies of security code end up. It owns *only* the comparison — no logins,
 * no sessions, no backoff; those are what earned the old DASHPASS system its
 * removal.
 *
 * A credential is presented three ways, in this order of preference:
 *
 *   - `x-<name>` header (scriptable, never logged by default)
 *   - `Authorization: Bearer <credential>`
 *   - `?<name>=<credential>` query, for a human opening a URL in a browser
 *     who cannot set a header — the caller is expected to strip it from the
 *     URL client-side; it *does* reach server logs, which is documented, and
 *     the header forms exist for anything automated.
 *
 * An empty or missing configured credential **disables** this path rather
 * than matching everything: `credential: import.meta.env.KEY` with the
 * variable unset must mean "off", not "open".
 *
 * The compare is constant-time. A plain `===` on a secret is a timing oracle,
 * and `timingSafeEqual` costs one line — but it throws on length mismatch, so
 * the length is checked first (which leaks only the length, never the bytes).
 */

import { timingSafeEqual } from 'node:crypto'

export function credentialMatches(
  configured: string | undefined,
  presented: string | null | undefined,
): boolean {
  if (!configured || !presented) return false

  const a = Buffer.from(configured)
  const b = Buffer.from(presented)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Pull a presented credential off a request: the `x-<name>` header, a Bearer
 * token, or the `<name>` query parameter, in that order. Returns `null` when
 * none is present. `name` is the header/query key — `db-key`, `analytics-key`.
 */
export function readCredential(req: Request, name: string): string | null {
  const header = req.headers.get(`x-${name}`)
  if (header) return header

  const bearer = req.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '')
    .trim()
  if (bearer) return bearer

  return new URL(req.url).searchParams.get(name)
}

/**
 * The whole check in one call: does the request present `configured` under
 * `name`? `false` for an unset credential or an absent presentation.
 */
export function requestHasCredential(
  req: Request,
  configured: string | undefined,
  name: string,
): boolean {
  if (!configured) return false
  return credentialMatches(configured, readCredential(req, name))
}
