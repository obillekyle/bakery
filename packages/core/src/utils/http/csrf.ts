/**
 * Cross-site request forgery guards.
 *
 * A `SameSite=Lax` cookie is still sent on top-level cross-site *navigations*,
 * so it is not on its own sufficient to protect a state-changing endpoint —
 * `<a href="/api/admin/delete?id=5">` or a cross-origin `<form>` POST both
 * arrive with the victim's session attached.
 */

import { Try } from '../isomorphic/try'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** `Sec-Fetch-Site` values that mean the request did not come from another site. */
const SAME_SITE_VALUES = new Set(['same-origin', 'same-site', 'none'])

/**
 * Returns a reason string when the request looks cross-site, or `null` when it
 * is safe to process. Requests with neither `Origin` nor `Sec-Fetch-Site` (curl,
 * server-to-server, older clients) are allowed — browsers always send at least
 * one of them on a cross-origin request.
 */
export function checkSameOrigin(req: Request, url: URL): string | null {
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite && !SAME_SITE_VALUES.has(fetchSite)) {
    return `cross-site request rejected (Sec-Fetch-Site: ${fetchSite})`
  }

  const origin = req.headers.get('origin')
  if (origin && origin !== 'null' && origin !== url.origin) {
    return `cross-origin request rejected (Origin: ${origin})`
  }

  return null
}

/**
 * Guard for endpoints that may change state. Safe methods pass through; unsafe
 * ones must be same-origin.
 */
export function checkCsrf(req: Request, url: URL): string | null {
  if (SAFE_METHODS.has(req.method)) return null
  return checkSameOrigin(req, url)
}

/**
 * An attacker-supplied header value, made safe to put in a reason string.
 *
 * Reason strings are logged, and the logger renders one record per line — so
 * an `Origin` carrying a newline could forge additional log entries. Anything
 * outside printable ASCII goes, and the result is capped: a rejection reason
 * is a diagnostic, not a transcript.
 */
function safeEcho(value: string): string {
  const clean = value.replace(/[^\x20-\x7e]/g, '')
  return clean.length > 128 ? `${clean.slice(0, 128)}...` : clean
}

/**
 * Origin guard for WebSocket upgrades — deliberately stricter than
 * `checkSameOrigin`, and applied in `upgradeWebsocket` so every socket
 * inherits it rather than each handler having to remember.
 *
 * WebSockets are exempt from the same-origin policy. Any page the developer
 * visits can open `ws://localhost:3000/_livereload`, and until this existed
 * one `{"type":"subscribe_logger"}` bought a live feed of the server log —
 * failing SQL, table and column names, absolute source paths — plus the
 * ability to reload every open browser. The only thing that separates the
 * app's own page from an attacker's is `Origin`, which the browser sets on
 * every handshake and page script cannot override.
 *
 * Three deliberate differences from `checkSameOrigin`:
 *
 * - **`Origin: null` is rejected.** That is what a sandboxed iframe, a `data:`
 *   URL and a `file://` page send, so treating it as "no origin" would hand
 *   the socket straight back to `<iframe sandbox srcdoc="...">` on the
 *   attacker's page. It falls out of the parse below: `new URL('null')`
 *   throws, and an unparseable origin fails closed.
 * - **`Sec-Fetch-Site` is not consulted.** Browsers do not send it on the
 *   handshake, so a value that *is* present came from a non-browser client
 *   and is worth nothing.
 * - **Hostnames are compared, not full origins.** A TLS-terminating reverse
 *   proxy leaves the request looking like `http://app.example:3000` while the
 *   browser reports `https://app.example`; comparing origins would refuse
 *   every socket in that (very ordinary) deployment. The residual is an
 *   attacker who already controls another port or scheme on the *same*
 *   hostname, which is a different and much smaller threat than "any website
 *   the developer visits".
 *
 * An **absent** `Origin` is allowed, and that is a decision rather than an
 * oversight. A browser never omits it on a handshake, so its absence means the
 * peer is not a browser — curl, a test, a CLI, a health check. Such a client
 * can also set `Origin` to whatever it likes, so refusing the absent case buys
 * no security at all while breaking every non-browser client. This check is
 * worth exactly what a browser's inability to forge the header is worth, and
 * handlers that need more (`/_analytics_ws` is the in-repo example) still
 * authenticate in their own `canHandle`.
 */
export function checkWebSocketOrigin(req: Request, url: URL): string | null {
  const origin = req.headers.get('origin')
  if (!origin) return null

  const rejected = `cross-origin WebSocket upgrade rejected (Origin: ${safeEcho(origin)})`

  const parsed = Try(() => new URL(origin))
  if (!parsed) return rejected

  return parsed.hostname.toLowerCase() === url.hostname.toLowerCase()
    ? null
    : rejected
}
