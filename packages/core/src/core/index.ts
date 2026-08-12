import { Logger, log } from '../logger'
import { definePlugin as _definePlugin } from '../plugins/types'
import { Case, is, Math2, match, Try } from '../utils/common'
import { encodeSSE, response, sse } from '../utils/http'
import Bakery, { getHostname, hostKey, hostStore } from './bakery'
import { getConfig, NOOP } from './config'
import { createElement, Fragment, html } from './jsx'

export const defineConfig = <T extends AppConfig>(config: T): T => config
export const definePlugin = _definePlugin

/**
 * Helper types, previously ambient globals. Importable so an app that declares
 * its own `MapOf` is not met with a redeclaration error it cannot opt out of.
 * The Route* types are the app-facing typing surface for route modules.
 */
export type {
  MapOf,
  MixedPromise,
  RouteBody,
  RouteHandler,
  RouteParam,
  RouteResponse,
  Wrapped,
} from '../types'
/** Configured in `server.config.ts`; the type is exported so an app can build one. */
export type { CorsOptions } from '../utils/http/cors'
export type { SSEMessage, SSEOptions, SSEStream } from '../utils/http/sse'
// The validation surface, so an app can type its own schemas and validators.
export type {
  FunctionValidator,
  StandardSchemaLike,
  ValidationIssue,
  Validator,
} from '../utils/http/validate'
/**
 * Identity at runtime, like `defineConfig`; exists so a route module can
 * declare its body shape once and have the whole signature inferred:
 *
 *   export default defineRoute<{ id: string }>((req, body) => …)
 *
 * `defineRoute`, not `defineHandler` — "handler" already means a registered
 * `Handler` subclass in this framework, and this defines a route module.
 */
export { defineRoute } from './define-route'

/**
 * Note the shape of the two lines below: `sse` and `encodeSSE` are *imported*
 * at the top of this file and re-exported here, not re-exported directly from
 * `../utils/http/sse`.
 *
 * That is not style. `export … from '../utils/http/sse'` adds a second edge
 * into the module graph and reorders evaluation enough to close the cycle this
 * barrel is always one step away from: it typechecks, and then 47 tests fail
 * with `ReferenceError: Cannot access 'Logger' before initialization`. Going
 * through the `utils/http` index — which line 4 already imports for `response`
 * — adds no edge at all. Every other value here follows the same rule.
 */
export {
  Bakery,
  Case,
  createElement,
  encodeSSE,
  Fragment,
  getConfig,
  // Multi-host helpers. Documented in docs/configuration/multi-host.md, and
  // the only reason `./core/bakery` had to be a subpath of its own.
  getHostname,
  hostKey,
  hostStore,
  html,
  html as HTMLBody,
  is,
  Logger,
  log,
  Math2,
  match,
  NOOP,
  response,
  sse,
  Try,
}

export default Bakery
