import {
  getClientIp,
  requestHasCredential,
} from '@bakery-framework/core/utils/http'

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
 * .DB_EXPLORER_KEY })`, presented as `x-db-key`, a Bearer token, or a
 * one-time `?db-key=` query the client strips from the URL. The comparison
 * lives in core (`requestHasCredential`) — one copy, shared with analytics;
 * this only names the key, `db-key`.
 */
export function credentialMatches(
  credential: string | undefined,
  req: Request,
): boolean {
  return requestHasCredential(req, credential, 'db-key')
}
