import { requestHasCredential } from '@bakery-framework/core/utils/http'

/**
 * Shared-credential access: `dbExplorerPlugin({ credential: import.meta.env
 * .DB_EXPLORER_KEY })`, presented as `x-db-key`, a Bearer token, or a
 * one-time `?db-key=` query the client strips from the URL. The comparison
 * lives in core (`requestHasCredential`) — one copy, shared with analytics;
 * this only names the key, `db-key`.
 *
 * Named `hasDbKey`, not `credentialMatches`, deliberately. Core exports a
 * `credentialMatches` of its own from the very barrel this file imports
 * (`@bakery-framework/core/utils/http`), and it takes
 * `(configured, presented: string | null | undefined)` where this takes
 * `(credential, req: Request)`. Two same-named functions with the same arity
 * and a different second parameter, one of them reachable by wildcard from a
 * module every caller here already imports, is a trap: the compiler catches
 * the direct substitution today only because `Request` is not assignable to
 * `string | null | undefined`, which is a coincidence of the current types
 * rather than a guarantee. The distinct name removes the question.
 */
export function hasDbKey(
  credential: string | undefined,
  req: Request,
): boolean {
  return requestHasCredential(req, credential, 'db-key')
}
