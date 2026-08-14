import { AsyncLocalStorage } from 'node:async_hooks'
import {
  credentialMatches,
  readCredential,
} from '@bakery-framework/core/utils/http'

/**
 * Who may do what in the explorer.
 *
 * The explorer used to be read-only by construction, so a boolean answered the
 * whole question. It edits rows now, and "may this request in" and "may this
 * request *write*" are different questions — so the predicate returns a level
 * rather than a yes.
 *
 * Two doors, and an application may use either or both:
 *
 *   - `users` — named credentials, for people and scripts that have no session
 *     (an on-call engineer with a key, a seeding job).
 *   - `authorize` — a predicate over the request, for applications that already
 *     know who their users are and would rather not keep a second list.
 *
 * Either can admit and the **higher** level wins, because they answer about the
 * same caller: a session admin presenting a read-only key is still an admin.
 *
 * Everything fails closed. Nothing configured admits nobody — the same default
 * the read-only explorer had, and the reason there is no `writes: true` flag to
 * leave set by accident.
 *
 * This deliberately does not reuse core's `isAuthorized`, which is boolean and
 * stays correct for the dashboard and analytics. It copies its discipline
 * instead: an exact match, never a truthy one, and a throw is a denial.
 */

/** What a caller may do. Ordered: `write` implies `read`. */
export type Access = 'read' | 'write'

/**
 * An application's own access check. Return `'write'`, `'read'`, or `false`.
 *
 * Anything else — including `true` — is a denial. The predicate is application
 * code and this return type is only advice; an untyped or transpiled one can
 * hand back anything, and admission is the expensive direction to get wrong.
 */
export type AccessFn = (
  req: Request,
) => Access | false | Promise<Access | false>

export interface ExplorerUser {
  /** Presented as `x-db-key`, a Bearer token, or `?db-key=` on a read. */
  credential: string
  access: Access
}

/** Named because a log line saying which key was used beats one saying "a key". */
export type ExplorerUsers = Record<string, ExplorerUser>

const DB_KEY = 'db-key'

/** Methods that cannot change state, and may therefore carry a URL credential. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const RANK: Record<Access, number> = { read: 1, write: 2 }

/** The higher of two grants, or whichever is present. */
function higher(a: Access | false, b: Access | false): Access | false {
  if (!a) return b
  if (!b) return a
  return RANK[a] >= RANK[b] ? a : b
}

/**
 * The credential this request presents, or `null`.
 *
 * Core's `readCredential` accepts three forms — `x-db-key`, a Bearer token, and
 * `?db-key=` — and the query form is deliberate there: a human opening a URL
 * cannot set a header.
 *
 * **On a state-changing request the query form is refused.** A credential in a
 * URL is what makes a cross-site write possible: the browser will send it
 * because it is in the link, and `checkCsrf` — which is an `Origin` check, not
 * a token — passes when `Origin` is absent or literally `"null"`, as it is from
 * a sandboxed iframe or some redirect chains. Requiring a header for writes
 * means the caller had to run script on this origin.
 */
function presentedKey(req: Request): string | null {
  const presented = readCredential(req, DB_KEY)
  if (presented === null) return null
  if (SAFE_METHODS.has(req.method)) return presented

  // `readCredential` prefers header, then Bearer, then the query — so if
  // neither header is present, the value it returned came from the URL.
  const fromHeader =
    req.headers.has(`x-${DB_KEY}`) || req.headers.has('authorization')
  return fromHeader ? presented : null
}

/**
 * The best level any configured user grants this request.
 *
 * **Every entry is compared, with no early exit.** Each comparison is constant
 * time (core's `credentialMatches`), and stopping at the first match would make
 * the response time depend on where in the map the matching key sits — which
 * leaks the position of a valid key over enough samples.
 */
export function accessFromUsers(
  req: Request,
  users: ExplorerUsers | undefined,
): Access | false {
  if (!users) return false

  const presented = presentedKey(req)
  if (!presented) return false

  let granted: Access | false = false
  for (const user of Object.values(users)) {
    if (credentialMatches(user.credential, presented)) {
      granted = higher(granted, user.access)
    }
  }
  return granted
}

/** The predicate's answer, with anything that is not an exact level denied. */
export async function accessFromPredicate(
  req: Request,
  authorize: AccessFn | undefined,
): Promise<Access | false> {
  if (!authorize) return false

  try {
    const answer = await authorize(req)
    // `=== `, never truthiness. `true` is a denial here on purpose: a predicate
    // written against the old boolean API means "let them in" and cannot mean
    // "let them write", and guessing which is exactly the mistake this type
    // exists to prevent.
    return answer === 'write' || answer === 'read' ? answer : false
  } catch {
    // An access check that errors is indeterminate, and indeterminate is a
    // denial (convention 2).
    return false
  }
}

export interface AccessConfig {
  users?: ExplorerUsers
  authorize?: AccessFn
}

/** The caller's level: the better of the two doors, `false` if neither admits. */
export async function resolveAccess(
  req: Request,
  config: AccessConfig,
): Promise<Access | false> {
  // Both doors are consulted even when the first admits — the predicate may
  // grant `write` where a key granted `read`, and the caller is one person.
  const fromKey = accessFromUsers(req, config.users)
  const fromPredicate = await accessFromPredicate(req, config.authorize)
  return higher(fromKey, fromPredicate)
}

/** Whether `access` permits a write. Spelled once so no call site guesses. */
export function canWrite(access: Access | false): boolean {
  return access === 'write'
}

/**
 * The current request's access level, for endpoints.
 *
 * `AsyncLocalStorage` rather than a module variable, for the same reason
 * `hostStore` is one in core: a module variable is shared by every in-flight
 * request, so under any concurrency at all one caller's level would decide
 * another caller's write. It is also cheaper than re-resolving per endpoint,
 * which would run an application's `authorize` predicate — possibly a session
 * lookup — twice for one request.
 *
 * Outside a request it is `false`, which is the safe answer rather than a
 * crash: an endpoint reached some other way has no caller to grant anything.
 */
export const accessStore = new AsyncLocalStorage<Access>()

export function currentAccess(): Access | false {
  return accessStore.getStore() ?? false
}

/** Whether the *current* request may write. The check every write endpoint makes. */
export function currentCanWrite(): boolean {
  return canWrite(currentAccess())
}
