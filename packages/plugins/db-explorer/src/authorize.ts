import { getClientIp } from '@bakery-framework/core/utils/http'

/**
 * Decides whether a request may use the explorer.
 *
 * Same design as the dashboard's guard, for the same reason: the explorer
 * authenticates nobody itself. The host application, which already knows who
 * its users are, supplies a predicate; without one, access is loopback-only
 * in development and denied outright in production, so an unconfigured
 * explorer is never exposed.
 */
export type AuthorizeFn = (req: Request) => boolean | Promise<boolean>

/**
 * Addresses only, never hostnames: a peer address is not the string
 * `localhost`, and matching the request's hostname would trust a header the
 * client chooses (`Host: localhost` from anywhere on the LAN, with the dev
 * server listening on 0.0.0.0).
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when the request came from this machine. */
export function isLoopback(req: Request): boolean {
  // The peer address is the only evidence here the client does not choose.
  // getClientIp reads config and the live server, either of which may be
  // absent (tests, early boot). An address that cannot be determined is
  // indeterminate, and per convention 2 an indeterminate answer is a denial —
  // not a reason to consult something the requester controls.
  let ip = ''
  try {
    ip = getClientIp(req)
  } catch {
    return false
  }
  return LOOPBACK.has(ip)
}

/**
 * The default: loopback in dev, nothing in prod. `import.meta.env.PROD` read
 * at call time — the flag is process state, and tests flip it.
 */
export function defaultAuthorize(req: Request): boolean {
  if (import.meta.env.PROD) return false
  return isLoopback(req)
}

export function resolveAuthorize(fn?: AuthorizeFn): AuthorizeFn {
  return fn ?? defaultAuthorize
}

/**
 * Guard semantics per convention 2: the *authorizer* may throw or hang-fail;
 * the answer to any indeterminate state is denial.
 */
export async function isAuthorized(
  authorize: AuthorizeFn,
  req: Request,
): Promise<boolean> {
  try {
    return (await authorize(req)) === true
  } catch {
    // A predicate that throws is indeterminate, and indeterminate is denied.
    return false
  }
}

/**
 * Shared-credential access: `dbExplorerPlugin({ credential: import.meta.env
 * .DB_EXPLORER_KEY })`.
 *
 * Accepted as `Authorization: Bearer <credential>`, an `x-db-key` header, or
 * — for the human opening `/_db` in a browser, who cannot type a header —
 * a one-time `?key=` query the client immediately strips from the URL and
 * keeps in sessionStorage. The query spelling does land in server logs;
 * that is documented, and header spellings exist for anything scripted.
 *
 * An empty or missing credential **disables** this path rather than matching
 * everything: `credential: import.meta.env.KEY` with the variable unset must
 * mean "off", not "open".
 *
 * Compared in constant time. The dashboard's old DASHPASS system earned its
 * removal by owning logins, sessions and backoff; a bearer-style check owns
 * none of that — but a plain `===` on a secret is still a timing oracle, and
 * `timingSafeEqual` costs one line.
 */
export function credentialMatches(
  credential: string | undefined,
  req: Request,
): boolean {
  if (!credential) return false

  const presented =
    req.headers.get('x-db-key') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    new URL(req.url).searchParams.get('key')

  if (!presented) return false

  const a = Buffer.from(credential)
  const b = Buffer.from(presented)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
