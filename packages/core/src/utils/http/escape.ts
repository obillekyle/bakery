/**
 * Server-facing path for the escaping primitives.
 *
 * The implementation lives in `utils/isomorphic/escape` because the browser
 * bundle needs it too; server code imports it from here (or from `@server/utils`)
 * so callers don't have to know which side of that boundary it sits on.
 */
export { escapeHtml, escapeScriptJson } from '../isomorphic/escape'
