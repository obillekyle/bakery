import { is } from '@bakery-framework/core/utils/common'
import { getClientIp } from '@bakery-framework/core/utils/http'
import { retryAfterSeconds } from './rate-limit'

/**
 * The three decisions `worker.ts`'s `fetch` makes that are pure functions of
 * their arguments.
 *
 * They were inline in the `Bun.serve` callback, which is unreachable from a
 * test: `worker.ts` calls `Bun.serve` at module scope, so importing it binds a
 * port. Nothing about them is server-specific, so they live here and the
 * callback calls them — the serve options are otherwise unchanged.
 */

/** The `rateLimit` config with the `false` (disabled) arm removed. */
export type RateLimitConfig = Exclude<ProcessedAppConfig['rateLimit'], false>

/**
 * Whether a handler's return value should be routed into the error registry.
 *
 * Two shapes count, and they are not interchangeable. A `Response` is an error
 * by its status; anything else is an error by carrying `errorCode`, which is
 * what `ErrorHandler.extractErrorData` reads.
 *
 * The `is.object` guard is load-bearing twice over. `'errorCode' in res` is a
 * `TypeError` on a primitive, and `Try.return`'s failure sentinel is a
 * `symbol` — so the guard is what keeps the rejection path from throwing
 * inside the code that exists to handle throws. Note `is.object([])` is
 * deliberately `true` (see CLAUDE.md); an array simply has no `errorCode`.
 *
 * 400 is included: `>= 400`, not `> 400`. A handler returning a bare
 * `new Response(…, {status: 404})` must still reach `TSXErrorHandler` and get
 * the app's error page rather than an empty body.
 */
export function isErrorResult(res: unknown): boolean {
  if (res instanceof Response) return res.status >= 400
  return is.object(res) && 'errorCode' in res
}

/**
 * Which token bucket this request spends from.
 *
 * The `|| hostname` is not a tidy-up. An empty key is a *valid* string that
 * hashes to one fixed slot, so every client whose IP could not be determined —
 * which is all of them when `Bakery.server` is not yet assigned, and any of
 * them behind a proxy with `trustProxy` off — would share a single bucket and
 * 429 each other. Falling back to the hostname keeps the collision at
 * per-host, which is the coarsest grouping that is still meaningful.
 */
export function rateLimitKey(
  rl: RateLimitConfig,
  req: Request,
  hostname: string,
): string {
  return (rl.keyBy ? rl.keyBy(req) : getClientIp(req)) || hostname
}

/**
 * The 429 a rejected request receives.
 *
 * `Retry-After` is whole seconds per RFC 9110 and never 0 — see
 * `retryAfterSeconds`.
 */
export function tooManyRequests(refill: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds(refill)) },
  })
}
