/**
 * The request-predicate half of plugin authorization.
 *
 * One implementation, deliberately in core, for the same reason
 * `credential.ts` is here: the dashboard, db-explorer and analytics plugins
 * each need this guard, and per-plugin copies of security code drift. These
 * three had already drifted — one coerced its predicate's return with
 * `Boolean`, one gated on `!DEV` where the others read `PROD`, one swallowed a
 * `getClientIp` throw into an empty string and carried on. Each divergence is
 * resolved below toward the fail-closed reading, and each is marked as a
 * decision rather than left to look like a style choice.
 *
 * It owns *only* the predicate — no logins, no sessions, no backoff. The shared
 * key path is `credential.ts`; a plugin that offers both doors composes them.
 *
 * `getClientIp` is imported from `./ip` directly, never through this
 * directory's barrel or `@bakery-framework/core`: a core module that reaches for a
 * barrel closes an import cycle, which is how 67 tests once failed with
 * `ReferenceError: Cannot access 'Logger' before initialization`.
 */

import { getClientIp } from './ip'

/**
 * A host application's access predicate. Returning `true` admits; returning
 * anything else, or throwing, denies (convention 2).
 *
 * The framework authenticates nobody. The application, which already knows who
 * its users are, supplies this.
 */
export type AuthorizeFn = (req: Request) => boolean | Promise<boolean>

/**
 * Addresses only, never hostnames. Module-private: neither plugin copy
 * exported it, and the membership test is the whole of the useful surface.
 *
 * `'localhost'` used to be a member, back when the request's *hostname* was
 * compared against this set as well. A peer address is never the string
 * `localhost`, and accepting it meant `X-Forwarded-For: localhost` counted as
 * loopback under `trustProxy` — and, worse, that `new URL(req.url).hostname`
 * did too. Bun builds that from the client's own `Host` header and
 * `DEFAULT_HOST` is 0.0.0.0, so any peer on the LAN could send
 * `Host: localhost` and be handed a database browser.
 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** True when the request came from this machine. */
export function isLoopback(req: Request): boolean {
  // The peer address is the only evidence here the client does not choose.
  //
  // DECISION (divergence 3): a throw returns `false` immediately rather than
  // falling through with `ip = ''`. `getClientIp` reads config and the live
  // server, either of which may be absent (tests, early boot). The two spell
  // the same answer today, because `LOOPBACK.has('')` is false — but only by
  // coincidence, and the fall-through invites a later edit that adds a second
  // source of evidence below this line and silently consults it on the
  // indeterminate path. Returning here says the answer is settled: no address
  // means no evidence, and per convention 2 an indeterminate answer is a
  // denial, not a reason to ask something the requester controls.
  try {
    return LOOPBACK.has(getClientIp(req))
  } catch {
    return false
  }
}

/**
 * The default when an application configures no predicate: loopback in
 * development, nobody in production. Forgetting to configure a plugin
 * therefore cannot expose it to the internet.
 */
export function defaultAuthorize(req: Request): boolean {
  // DECISION (divergence 2): gate on `PROD`, not `!DEV`, and read it at call
  // time — the mode flags are accessors on `process.env` (`core/init.ts`), so
  // they are process state and tests flip them.
  //
  // The two spellings look interchangeable because `init.ts` derives them as
  // complements (`PROD = !isDev && !--dev-worker`). They are not, because they
  // are *independently settable* accessors and the test fixtures set them one
  // at a time: `asDev` flips `DEV` alone and leaves the ambient `PROD` — which
  // under `bun test` is `true` — in place. In that state `!DEV` admits a
  // loopback caller and `PROD` denies, so `PROD` is both the fail-closed
  // reading and the one that literally names the condition it means, rather
  // than inferring production from the absence of development.
  //
  // Hence a test for the *positive* development marker rather than a truthiness
  // test on `PROD`, which is the one place a bare `PROD` gate would be weaker
  // than `!DEV`. The flags do not exist until `core/init.ts` has run, and
  // `if (undefined)` falls straight through to the loopback check — so an
  // uninitialised process would open the door an initialised production one
  // keeps shut. Unset is not evidence of development; it is no evidence at all.
  //
  // This read `PROD !== false` while the flags were real booleans. Bun 1.4
  // rejects accessor descriptors on `process.env`, so they are `'1'`/`''`
  // strings now (see `core/init.ts`) — and `!== false` is true for *every*
  // string, including the `''` a development server sets, so the gate would
  // have denied on loopback in development while still looking correct.
  // `DEV === '1'` is the same statement in the encoding that survives: only a
  // booted development server sets it, and production (`''`) and never-booted
  // (`undefined`) both fail it.
  //
  // `isLoopback` would very likely deny on its own there, having no config or
  // server to read an address from. That is a second line of defence, not this
  // one's excuse: a guard should not depend on another guard's failure mode.
  if (import.meta.env.DEV !== '1') return false
  return isLoopback(req)
}

/** The configured predicate, or the fail-closed default. */
export function resolveAuthorize(fn?: AuthorizeFn): AuthorizeFn {
  return fn ?? defaultAuthorize
}

/**
 * Run a predicate without letting a broken one grant access. Guard semantics
 * per convention 2: the *authorizer* may throw or answer nonsense, and the
 * answer to any indeterminate state is denial.
 */
export async function isAuthorized(
  authorize: AuthorizeFn,
  req: Request,
): Promise<boolean> {
  try {
    // DECISION (divergence 1): `=== true`, never `Boolean(...)`. The predicate
    // comes from application code and `AuthorizeFn`'s return type is only
    // advice — an untyped, transpiled or `as any` predicate can hand back
    // anything. `Boolean` admits every truthy non-boolean, so a check that
    // answers with a status string denies on `""` and *grants* on `"no"`, and
    // one that answers with a count grants on any non-zero. Admission is the
    // expensive direction to get wrong; require the exact affirmative.
    return (await authorize(req)) === true
  } catch {
    // A predicate that throws is indeterminate, and indeterminate is denied.
    return false
  }
}
