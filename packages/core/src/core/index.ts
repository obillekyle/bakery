import { Logger, log } from '../logger'
import { definePlugin as _definePlugin } from '../plugins/types'
import type { RouteHandler } from '../types'
import { Case, is, Math2, match, Try } from '../utils/common'
import { response } from '../utils/http'
import Bakery, { getHostname, hostKey, hostStore } from './bakery'
import { getConfig, NOOP } from './config'
import { createElement, Fragment, html } from './jsx'

export const defineConfig = <T extends AppConfig>(config: T): T => config
export const definePlugin = _definePlugin

/**
 * Identity at runtime, like `defineConfig`; exists so a route module can
 * declare its body shape once and have the whole signature inferred:
 *
 *   export default defineRoute<{ id: string }>((req, body) => …)
 *
 * `defineRoute`, not `defineHandler` — "handler" already means a registered
 * `Handler` subclass in this framework, and this defines a route module.
 */
export const defineRoute = <P = {}>(fn: RouteHandler<P>): RouteHandler<P> => fn

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
  RouteResponse,
  Wrapped,
} from '../types'

export {
  Bakery,
  Case,
  createElement,
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
  Try,
}

export default Bakery
