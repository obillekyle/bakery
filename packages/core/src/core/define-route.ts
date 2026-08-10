import type { RouteHandler } from '../types'
import { response } from '../utils/http'
import { type Validator, validate } from '../utils/http/validate'

/**
 * `defineRoute`, in its own module rather than in `core/index.ts`.
 *
 * `core/index.ts` is a barrel — it pulls in the logger, plugins, jsx and utils —
 * so anything importing it from *inside* core closes a cycle and dies with
 * `ReferenceError: Cannot access 'Logger' before initialization`. That is
 * recorded in CLAUDE.md as costing 67 tests once; it cost this file's own tests
 * a second time, which is what moved it here. Consumers still reach it through
 * the barrel; core's modules and tests import this file directly.
 */

/**
 * Identity at runtime in its one-argument form; exists so a route module can
 * declare its body shape once and have the whole signature inferred:
 *
 *   export default defineRoute<{ id: string }>((req, body) => …)
 *
 * With a validator, it also *enforces* that shape — see the overload below.
 *
 * `defineRoute`, not `defineHandler` — "handler" already means a registered
 * `Handler` subclass in this framework, and this defines a route module.
 */
export function defineRoute<P = {}>(fn: RouteHandler<P>): RouteHandler<P>
/**
 * Validate the body before the handler runs.
 *
 *   export default defineRoute({ body: schema }, (req, body) => …)
 *
 * `body` is a Standard Schema (zod, valibot, arktype — Bakery imports none of
 * them) or a plain function returning the parsed value. A rejection answers
 * `400` through the framework's JSON envelope and the handler never runs.
 */
export function defineRoute<T>(
  options: { body: Validator<T> },
  fn: RouteHandler<T>,
): RouteHandler<T>
export function defineRoute(
  a: RouteHandler<any> | { body: Validator<any> },
  b?: RouteHandler<any>,
): RouteHandler<any> {
  // One argument: identity, unchanged. Types only, no runtime cost — every
  // existing route keeps working byte for byte.
  if (typeof a === 'function') return a

  const { body: validator } = a
  const fn = b as RouteHandler<any>

  return async function validatedRoute(req, body, server) {
    const result = await validate(validator, body)
    if (!result.ok) {
      // The framework's one JSON envelope, so a validation failure looks like
      // every other error a client receives rather than a special case.
      return response.json.error(400, 'Invalid request body', {
        issues: result.issues,
      })
    }
    // The *parsed* value, not the raw body: a schema that coerces or strips
    // unknown keys is doing so precisely to be used, and handing the handler
    // the original would make the coercion a lie.
    return fn(req, result.value, server)
  }
}
