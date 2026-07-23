import { Logger, log } from '../logger'
import { definePlugin as _definePlugin } from '../plugins/types'
import { Case, is, Math2, match, Try } from '../utils/common'
import { response } from '../utils/http'
import Bakery from './bakery'
import { getConfig, NOOP } from './config'
import { createElement, Fragment, html } from './jsx'

// Definitions
export const defineConfig = <T extends AppConfig>(config: T): T => config
export const definePlugin = _definePlugin

// Core exports
export {
  Bakery,
  Case,
  createElement,
  Fragment,
  getConfig,
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

// Default export
export default Bakery
