import type { Handler } from '@bakery-framework/core/handlers'
import { is } from '@bakery-framework/core/utils/common'
import {
  getClientIp,
  type RateLimitKey,
} from '@bakery-framework/core/utils/http'
import { retryAfterSeconds } from './rate-limit'

/**
 * The decisions `worker.ts`'s `fetch` makes that are pure functions of their
 * arguments.
 *
 * They were inline in the `Bun.serve` callback, which is unreachable from a
 * test: `worker.ts` calls `Bun.serve` at module scope, so importing it binds a
 * port. Nothing about them is server-specific, so they live here and the
 * callback calls them: the serve options are otherwise unchanged.
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
 * `symbol`, so the guard is what keeps the rejection path from throwing
 * inside the code that exists to handle throws. Note `is.object([])` is
 * deliberately `true` (see CLAUDE.md); an array simply has no `errorCode`.
 *
 * 400 is included: `>= 400`, not `> 400`. A handler returning a bare
 * `new Response(…, {status: 404})` must still reach `TSXErrorHandler` and get
 * the app's error page rather than an empty body.
 *
 * A Response whose body the app wrote as a document is not an error to dress,
 * whatever its status: `hasOwnDocument`. The registry keeps only the status
 * of what it replaces, so through 2.2.2 an `onRequest` answering with its own
 * 404 page came back as the app's `error-404.html` (or Bakery's own page),
 * and an API route's `Response.json({ error }, { status: 404 })` as an
 * envelope whose message read `404`.
 */
export function isErrorResult(res: unknown): boolean {
  if (res instanceof Response) return res.status >= 400 && !hasOwnDocument(res)
  return is.object(res) && 'errorCode' in res
}

/**
 * Whether an error Response carries a document of its own: a body typed as
 * anything but plain text (an HTML page, a JSON document, an uploaded site's
 * `404.html`).
 *
 * What asks to be dressed is untyped or plain text: `response.error()`, a
 * null body, and a string body such as the router's own
 * `new Response('Not Found', { status: 404 })`, which Bun leaves untyped until
 * it is sent. Those still get the app's error page, or the JSON envelope under
 * `/api`.
 *
 * The header alone, never `res.body`: on Bun 1.4.2 reading the body of a Blob
 * or file Response first makes its `content-type` read `null`, so
 * `new Response(Bun.file('404.html'), { status: 404 })` would be judged
 * untyped and dressed.
 */
export function hasOwnDocument(res: Response): boolean {
  const type = res.headers.get('content-type')
  return Boolean(type) && !/^text\/plain\b/i.test(type!)
}

/**
 * One bucket a request can be charged to: the top level, or a route rule,
 * checked and ready to match.
 */
export interface RateLimitBucket {
  /**
   * `''` for the top level, the rule's prefix (lower case, one slash between
   * segments) otherwise. Prepended to every key the bucket hashes, so a client
   * spending at `/api/auth` and the same client spending elsewhere draw from
   * two buckets, not one.
   */
  prefix: string
  /** The prefix's segments, compared against the request's. */
  segments: string[]
  max: number
  refill: number
  keyBy?: RateLimitKey
}

/** `rateLimit` checked once: the top-level bucket, and the rules most specific first. */
export interface CompiledRateLimit {
  base: RateLimitBucket
  routes: RateLimitBucket[]
}

/**
 * Keyed by the setting object, which is frozen with the config for the life
 * of the process, so each host's `rateLimit` is checked once. Weak, because a
 * test seam (`__setTestConfig`) hands in new objects freely.
 */
const compiled = new WeakMap<RateLimitConfig, CompiledRateLimit>()

/** A path's segments the way routing reads them: no empty ones, any case. */
function pathSegments(path: string): string[] {
  return path.toLowerCase().split('/').filter(Boolean)
}

function checkBudget(where: string, max: unknown, refill: unknown): void {
  if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) {
    throw new Error(`${where}.max must be a number of 1 or more, got ${max}`)
  }
  if (typeof refill !== 'number' || !Number.isFinite(refill) || refill <= 0) {
    throw new Error(
      `${where}.refill must be a number above 0 (1 / 60 is one a minute), got ${refill}`,
    )
  }
}

function checkKeyBy(where: string, keyBy: unknown): void {
  if (keyBy !== undefined && typeof keyBy !== 'function') {
    throw new Error(`${where}.keyBy must be a function`)
  }
}

/**
 * Check a `rateLimit` setting and put its rules in matching order.
 *
 * Throws on a setting that cannot mean anything, naming the field: a refill
 * of 0, a prefix without its leading slash, two rules for one prefix.
 * `worker.ts` calls this for the base config and every host before it
 * serves, so a typo stops the boot instead of surfacing on some later
 * request, or as a bucket that admits nothing, which is what the pool makes
 * of a refill it cannot use.
 */
export function compileRateLimit(
  rl: RateLimitConfig,
  where = 'rateLimit',
): CompiledRateLimit {
  const known = compiled.get(rl)
  if (known) return known

  checkBudget(where, rl.max, rl.refill)
  checkKeyBy(where, rl.keyBy)
  if (rl.routes !== undefined && !Array.isArray(rl.routes)) {
    throw new Error(`${where}.routes must be an array of rules`)
  }

  const seen = new Set<string>()
  const routes: RateLimitBucket[] = (rl.routes ?? []).map((rule, i) => {
    const at = `${where}.routes[${i}]`
    if (typeof rule?.prefix !== 'string' || !rule.prefix.startsWith('/')) {
      throw new Error(`${at}.prefix must be a path starting with "/"`)
    }
    checkBudget(at, rule.max, rule.refill)
    checkKeyBy(at, rule.keyBy)

    const segments = pathSegments(rule.prefix)
    const prefix = `/${segments.join('/')}`
    if (seen.has(prefix)) {
      throw new Error(`${at}.prefix covers ${prefix}, as an earlier rule does`)
    }
    seen.add(prefix)
    return {
      prefix,
      segments,
      max: rule.max,
      refill: rule.refill,
      keyBy: rule.keyBy,
    }
  })
  // Longest first, so the first rule that matches is the most specific. Two
  // rules of one length match the same path only if they are the same
  // prefix, which the check above refuses.
  routes.sort((a, b) => b.segments.length - a.segments.length)

  const out: CompiledRateLimit = {
    base: {
      prefix: '',
      segments: [],
      max: rl.max,
      refill: rl.refill,
      keyBy: rl.keyBy,
    },
    routes,
  }
  compiled.set(rl, out)
  return out
}

/**
 * Check the base `rateLimit` and every host's, so a bad one fails the boot.
 * A host entry's setting reaches requests as the same object (`config.ts`
 * merges it by reference), so what is checked here is what is served.
 */
export function checkRateLimits(config: Readonly<ProcessedAppConfig>): void {
  if (config.rateLimit) compileRateLimit(config.rateLimit)
  for (const [host, entry] of Object.entries(config.hosts ?? {})) {
    if (entry?.rateLimit) {
      compileRateLimit(entry.rateLimit, `hosts['${host}'].rateLimit`)
    }
  }
}

/**
 * The bucket a path is charged to: the rule with the longest prefix covering
 * it, else the top level.
 *
 * Matched on segments, empty ones dropped and case folded, because that is how
 * routing reads a path: `$routing.ts` splits on `/` and filters out the empty
 * parts, so `/api//auth/sign-in` reaches `api/auth/sign-in.ts`. A rule matched
 * on the raw string would let that spelling through on the top-level budget.
 * Case is folded so a case-insensitive filesystem cannot open the same gap;
 * where routing would refuse the spelling, charging it to the rule costs
 * nothing.
 */
export function rateLimitBucket(
  limit: CompiledRateLimit,
  path: string,
): RateLimitBucket {
  if (limit.routes.length === 0) return limit.base

  const segments = pathSegments(path)
  for (const rule of limit.routes) {
    if (rule.segments.length > segments.length) continue
    let i = 0
    while (i < rule.segments.length && rule.segments[i] === segments[i]) i++
    if (i === rule.segments.length) return rule
  }
  return limit.base
}

/**
 * Which token bucket this request spends from, within its rule.
 *
 * `keyBy` first, then the client address, then the hostname. A `keyBy` that
 * returns nothing hands the request to its address rather than to a key it
 * shares with every other unclassified request, which is what makes "the
 * account when signed in, the address when not" one line:
 * `keyBy: req => req.session.get('accountId')`.
 *
 * The `|| hostname` is not a tidy-up. An empty key is a *valid* string that
 * hashes to one fixed slot, so every client whose IP could not be determined,
 * which is all of them when `Bakery.server` is not yet assigned, and any of
 * them behind a proxy with `trustProxy` off: would share a single bucket and
 * 429 each other. Falling back to the hostname keeps the collision at
 * per-host, which is the coarsest grouping that is still meaningful.
 */
export function rateLimitKey(
  bucket: { keyBy?: RateLimitKey },
  req: Request,
  hostname: string,
): string {
  return bucket.keyBy?.(req) || getClientIp(req) || hostname
}

/**
 * The string a request's bucket is hashed from: its key, behind the rule's
 * prefix when there is one. A newline cannot reach a key from a client (HTTP
 * refuses one in a header value, and so in a cookie), so no key can pose as
 * another rule's.
 */
export function bucketKey(bucket: RateLimitBucket, key: string): string {
  return bucket.prefix ? `${bucket.prefix}\n${key}` : key
}

/**
 * Whether a request was served as an asset: answered under 400 by a handler
 * that says, of this request, that what it served was one. See
 * `Handler.isAsset`. A status of 0 stands for no response at all, a
 * WebSocket upgrade for one.
 */
export function answeredAsAsset(
  handler: typeof Handler | undefined,
  path: string,
  req: Request,
  status: number,
): boolean {
  return (
    handler !== undefined &&
    status > 0 &&
    status < 400 &&
    handler.isAsset(path, req)
  )
}

/**
 * The 429 a rejected request receives.
 *
 * `Retry-After` is whole seconds per RFC 9110 and never 0. See
 * `retryAfterSeconds`.
 */
export function tooManyRequests(refill: number): Response {
  return new Response('Too Many Requests', {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds(refill)) },
  })
}
