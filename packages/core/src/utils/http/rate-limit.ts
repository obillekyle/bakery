/**
 * The shape of the `rateLimit` setting. Types only: the limiter itself runs in
 * `@bakery-framework/cli` (`worker.ts`), before a request is routed, and its
 * buckets live in the shared pool (`utils/shared-pool.ts`).
 *
 * Every bucket is a token bucket: it holds up to `max` tokens, a request
 * spends one, and `refill` tokens come back each second. A request that finds
 * its bucket empty is answered 429 with a `Retry-After` header.
 */

/** Who a request counts against. Nothing, or `''`, falls back to the client address, then the hostname. */
export type RateLimitKey = (req: Request) => string | null | undefined

/**
 * A budget for one part of the site, kept in buckets of its own.
 *
 * A request is charged to the rule with the longest prefix that covers its
 * path, and to that rule only: it does not also spend from the top-level
 * bucket. A path no rule covers spends from the top level.
 */
export interface RateLimitRule {
  /**
   * The path the rule covers, matched by whole segments and ignoring case,
   * the way routing reads a path: `/api/auth` covers `/api/auth`,
   * `/api/auth/sign-in` and `/API//Auth/sign-in/`, and not `/api/authors`.
   */
  prefix: string
  /** The largest burst one caller can make here: the bucket's size. */
  max: number
  /** Tokens back per second; fractions work, so `1 / 30` is one every thirty seconds. */
  refill: number
  /**
   * Who the caller is, for this rule. When it is left out the key is the
   * client address, whatever the top-level `keyBy` says: a rule usually
   * guards something worth attacking (sign-in, a password reset), and an
   * address cannot be multiplied by opening more sessions.
   */
  keyBy?: RateLimitKey
}

/** The `rateLimit` setting, when it is not `false`. */
export interface RateLimitOptions {
  /** The largest burst one caller can make: the bucket's size. */
  max: number
  /** Tokens back per second; fractions work, so `0.5` is one every two seconds. */
  refill: number
  /**
   * Who the caller is. Without it the key is the client address
   * (`utils/http/ip.ts`), and so it is whenever this returns nothing. Return
   * an account id for signed-in requests to give each account its own bucket
   * behind a shared address, a school's or an office's.
   */
  keyBy?: RateLimitKey
  /** Budgets for parts of the site. See `RateLimitRule`. */
  routes?: RateLimitRule[]
}
