import { getClientIp } from '@bakery/core/utils/http'

/**
 * Decides whether a request may use the console.
 *
 * The dashboard used to run its own identity system: a shared `DASHPASS`
 * secret, a login form, a session flag, a constant-time compare and a
 * failed-attempt backoff map. That is a lot of security-sensitive surface for
 * a framework to own, and it composed with nothing — an app with real users
 * and roles still had to hand out a second, shared password.
 *
 * So the dashboard no longer authenticates anyone. The host application, which
 * already knows who its users are, supplies a predicate.
 */
export type AuthorizeFn = (req: Request) => boolean | Promise<boolean>

/**
 * Addresses only. `'localhost'` used to be a member because the request's
 * *hostname* was compared against this set as well — see below for why that is
 * gone. A peer address is never the string `localhost`, and accepting it would
 * mean an `X-Forwarded-For: localhost` counted as loopback under `trustProxy`.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when the request came from this machine. */
export function isLoopback(req: Request): boolean {
  // The peer address is the only evidence here the client does not choose.
  // This used to fall back to `new URL(req.url).hostname`, which Bun builds
  // from the client's own `Host` header — and `DEFAULT_HOST` is 0.0.0.0, so a
  // dev server listens on every interface. Any peer on the LAN could send
  // `Host: localhost` and be handed the database browser.
  //
  // getClientIp reads config and the live server, either of which may be
  // absent (tests, early boot). An address that cannot be determined is
  // indeterminate, and an indeterminate answer is a denial — not a reason to
  // consult something the requester controls.
  let ip = ''
  try {
    ip = getClientIp(req)
  } catch {
    // See above: no server and no config means no evidence, which is a denial.
    ip = ''
  }

  return LOOPBACK.has(ip)
}

/**
 * Fail closed. With no predicate configured the console is reachable only from
 * loopback in development, and from nowhere in production — so forgetting to
 * configure it cannot expose a database browser to the internet.
 */
export function defaultAuthorize(req: Request): boolean {
  if (!import.meta.env.DEV) return false
  return isLoopback(req)
}

export function resolveAuthorize(authorize?: AuthorizeFn): AuthorizeFn {
  return authorize ?? defaultAuthorize
}

/**
 * Run a predicate without letting a throwing one grant access.
 */
export async function isAuthorized(
  authorize: AuthorizeFn,
  req: Request,
): Promise<boolean> {
  try {
    return Boolean(await authorize(req))
  } catch {
    // An authorization check that errors is indeterminate, and an
    // indeterminate answer is a denial.
    return false
  }
}
