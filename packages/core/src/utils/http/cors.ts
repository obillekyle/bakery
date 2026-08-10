/**
 * Cross-origin resource sharing.
 *
 * Bakery already ships the pieces of an API server — `ApiHandler`, sessions,
 * CSRF, rate limiting — and had no way to serve one to a browser on another
 * origin. This is that.
 *
 * Two halves, and both are needed: a preflight `OPTIONS` has to be answered
 * before routing (there is no route to run, and the browser will not send the
 * real request until it is answered), and every *other* response needs the
 * headers appended on the way out.
 *
 * **Nothing happens unless `cors` is configured.** No default origin, not even
 * a permissive one in development: a framework that quietly allows every origin
 * teaches people it works and then surprises them in production. An absent
 * config means the headers are never written, which is the browser's own
 * default and the safe one.
 */

/** What the app writes in `server.config.ts`. */
export interface CorsOptions {
  /**
   * Origins allowed to read responses.
   *
   * `'*'` is honoured literally, and is refused in combination with
   * `credentials` — see `resolveOrigin`. A function receives the request's
   * `Origin` and returns the value to echo, or `null` to deny.
   */
  origin: string | string[] | ((origin: string) => string | null)
  /** Defaults to the methods a browser will preflight for. */
  methods?: string[]
  /** Request headers the browser may send. Defaults to echoing what it asks. */
  allowHeaders?: string[]
  /** Response headers JavaScript may read. Nothing is exposed by default. */
  exposeHeaders?: string[]
  /** Send `Access-Control-Allow-Credentials`. Incompatible with `origin: '*'`. */
  credentials?: boolean
  /** Preflight cache lifetime in seconds. */
  maxAge?: number
}

const DEFAULT_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE']

/**
 * The value for `Access-Control-Allow-Origin`, or `null` to send nothing.
 *
 * **`'*'` with credentials is refused rather than silently downgraded.** The
 * browser rejects that pairing anyway, so honouring it would produce a request
 * that fails in the client with a CORS error and a server that believes it
 * allowed the call. Echoing the origin instead would be a *quiet widening* of
 * what the app asked for. Returning null makes the misconfiguration visible as
 * a denied request, which is the direction a security control should fail in.
 */
export function resolveOrigin(
  options: CorsOptions,
  requestOrigin: string | null,
): string | null {
  const { origin, credentials } = options

  if (origin === '*') return credentials ? null : '*'
  if (!requestOrigin) return null

  if (typeof origin === 'function') return origin(requestOrigin)
  if (Array.isArray(origin)) {
    return origin.includes(requestOrigin) ? requestOrigin : null
  }
  return origin === requestOrigin ? requestOrigin : null
}

/**
 * Headers for a non-preflight response, or `null` when the origin is denied.
 *
 * `Vary: Origin` is always set when the allowed origin is anything but `'*'`,
 * because the response now differs per origin and a shared cache that ignored
 * that would serve one origin's response to another.
 */
export function corsHeaders(
  options: CorsOptions,
  requestOrigin: string | null,
): Record<string, string> | null {
  const allowed = resolveOrigin(options, requestOrigin)
  if (allowed === null) return null

  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': allowed,
  }
  if (allowed !== '*') headers.Vary = 'Origin'
  if (options.credentials) {
    headers['Access-Control-Allow-Credentials'] = 'true'
  }
  if (options.exposeHeaders?.length) {
    headers['Access-Control-Expose-Headers'] = options.exposeHeaders.join(', ')
  }
  return headers
}

/**
 * The response to a preflight, or `null` if this is not one.
 *
 * A preflight is `OPTIONS` *with* `Access-Control-Request-Method` — plain
 * `OPTIONS` is a normal request and must fall through to routing, or an app
 * with its own OPTIONS route would find it shadowed.
 *
 * 204 rather than 200: there is no body, and some proxies treat a 200 with no
 * content-length as needing one.
 */
export function preflightResponse(
  options: CorsOptions,
  req: Request,
): Response | null {
  if (req.method !== 'OPTIONS') return null
  if (!req.headers.get('Access-Control-Request-Method')) return null

  const base = corsHeaders(options, req.headers.get('Origin'))
  // A denied origin still gets an answer, just without the headers that would
  // permit the call. Returning 403 here would be a worse signal: the browser
  // reports a CORS failure either way, and a 403 invites debugging the route.
  if (!base) return new Response(null, { status: 204 })

  const headers: Record<string, string> = {
    ...base,
    'Access-Control-Allow-Methods': (options.methods ?? DEFAULT_METHODS).join(
      ', ',
    ),
  }

  // Echoing the requested headers is what makes a default config usable:
  // enumerating every header a client might send is a list nobody maintains,
  // and getting it wrong fails at request time in the browser only.
  const requested = req.headers.get('Access-Control-Request-Headers')
  const allow = options.allowHeaders?.length
    ? options.allowHeaders.join(', ')
    : requested
  if (allow) headers['Access-Control-Allow-Headers'] = allow

  if (options.maxAge !== undefined) {
    headers['Access-Control-Max-Age'] = String(options.maxAge)
  }

  // Vary on the negotiated request headers too, for the same caching reason.
  headers.Vary = [headers.Vary, 'Access-Control-Request-Headers']
    .filter(Boolean)
    .join(', ')

  return new Response(null, { status: 204, headers })
}

/** Append the headers to a response that already exists. */
export function applyCors(
  options: CorsOptions,
  req: Request,
  res: Response,
): Response {
  const headers = corsHeaders(options, req.headers.get('Origin'))
  if (!headers) return res

  for (const [key, value] of Object.entries(headers)) {
    // `Vary` may already carry a value from ETag negotiation; appending keeps
    // both rather than dropping whichever ran second.
    if (key === 'Vary' && res.headers.has('Vary')) {
      const existing = res.headers.get('Vary') ?? ''
      if (!existing.split(',').some(v => v.trim() === value)) {
        res.headers.set('Vary', `${existing}, ${value}`)
      }
      continue
    }
    res.headers.set(key, value)
  }
  return res
}
