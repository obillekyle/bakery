# Middleware

Bakery provides two complementary mechanisms for intercepting requests before they reach a route handler: the `middleware` array and the `onRequest` hook. Both run at the highest priority in the handler pipeline (priority 100).

---

## `onRequest` Hook

The `onRequest` hook in `server.config.ts` is a single function called on **every request**. Return a `Response` to short-circuit the pipeline; return `void` to allow normal routing to continue.

```typescript
export default defineConfig({
  async onRequest(req: Request) {
    // Example: require API key for all /api/ routes
    if (req.url.includes('/api/') && !req.headers.get('x-api-key')) {
      return new Response(
        JSON.stringify({ status: 401, message: 'Unauthorized' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      )
    }
    // Return nothing to continue routing
  },
})
```

---

## `middleware` Array

The `middleware` array accepts multiple functions that are called in order. This is useful for composing independent concerns like CORS, rate limiting, or authentication:

```typescript
export default defineConfig({
  middleware: [
    corsMiddleware,
    rateLimitMiddleware,
    authMiddleware,
  ],
})
```

Each middleware function has this signature:

```typescript
type MiddlewareFn = (
  req: Request,
  server: Bun.Server,
) => Promise<Response | void> | Response | void
```

- Return a `Response` to halt the pipeline and send that response.
- Return `void` / `undefined` to pass to the next middleware.
- If all middleware pass, routing proceeds normally.

---

## Execution Order

```
Request arrives
    ↓
onRequest(req)            ← runs first, can short-circuit
    ↓ (if void returned)
middleware[0](req, srv)   ← first middleware
    ↓ (if void returned)
middleware[1](req, srv)   ← second middleware
    ↓ (if void returned)
... (remaining middleware)
    ↓ (if all pass)
Handler pipeline (ProxyHandler, ApiHandler, etc.)
```

---

## Practical Examples

### CORS Middleware

```typescript
// middleware/cors.ts
export async function corsMiddleware(req: Request): Promise<Response | void> {
  const origin = req.headers.get('origin') ?? '*'

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  // For actual requests, we cannot mutate headers here.
  // Use a plugin's onRequest to add headers to all responses instead.
}
```

### Authentication Guard

```typescript
// middleware/auth.ts
import { Session } from '@server/core/session'

const PROTECTED_PREFIXES = ['/admin', '/dashboard', '/api/private']

export async function authMiddleware(req: Request): Promise<Response | void> {
  const url = new URL(req.url)
  const isProtected = PROTECTED_PREFIXES.some(p => url.pathname.startsWith(p))

  if (!isProtected) return

  const session = Session.from(req)
  const userId = session.get('userId')

  if (!userId) {
    // Redirect HTML requests; return 401 for API requests
    if (req.headers.get('accept')?.includes('text/html')) {
      return Response.redirect('/login?next=' + encodeURIComponent(url.pathname), 302)
    }
    return new Response(
      JSON.stringify({ status: 401, message: 'Login required' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
```

### Rate Limiting

```typescript
// middleware/rate-limit.ts
const requestCounts = new Map<string, { count: number; resetAt: number }>()
const WINDOW_MS = 60_000  // 1 minute
const MAX_REQUESTS = 100

export function rateLimitMiddleware(req: Request): Response | void {
  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  const now = Date.now()
  const record = requestCounts.get(ip)

  if (!record || now > record.resetAt) {
    requestCounts.set(ip, { count: 1, resetAt: now + WINDOW_MS })
    return
  }

  record.count++
  if (record.count > MAX_REQUESTS) {
    return new Response('Too Many Requests', {
      status: 429,
      headers: {
        'Retry-After': String(Math.ceil((record.resetAt - now) / 1000)),
        'X-RateLimit-Limit': String(MAX_REQUESTS),
        'X-RateLimit-Remaining': '0',
      },
    })
  }
}
```

---

## Plugin-Based Middleware

For more complex middleware that needs access to startup config or needs to register at a specific priority, use the Plugin API instead. Plugins can intercept requests via `onRequest`:

```typescript
const myPlugin = definePlugin({
  name: 'my-plugin',
  onRequest(req) {
    // Same as middleware, but registered through the plugin system
  }
})
```

See [Plugin API →](../plugins/plugin-api.md) for details.

---

## Caveats

- Middleware cannot **add headers to successful responses** directly. To add response headers globally (e.g., CORS headers on non-preflight requests), use a plugin's `onRequest` hook that wraps the response, or use a `Response` subclass.
- Middleware runs **before** the ETag check. If middleware returns a `Response`, it will still go through ETag normalization.
- The `session` object is lazily initialized on the request. You can access it safely inside middleware: `req.session`.

---

*[← TSX Rendering](./tsx-rendering.md) · [Reverse Proxy →](./proxy.md)*

*[← Back to README](../../README.md)*
