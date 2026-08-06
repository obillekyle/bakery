# Reverse Proxy

Bakery includes a built-in reverse proxy that transparently forwards requests matching configured URL prefixes to upstream targets. It handles all HTTP methods, preserves headers, and streams response bodies.

---

## Configuration

Define proxy rules in `server.config.ts` using the `proxy` option:

```typescript
export default defineConfig({
  proxy: {
    '/api/v2': 'https://api.example.com',
    '/cdn':    'https://assets.mycdn.com',
    '/legacy': 'http://localhost:8080',
  },
})
```

Each key is a URL **prefix**. When an incoming request path starts with a prefix, the request is forwarded to the corresponding target.

---

## Path Rewriting

The prefix is **stripped** from the path before forwarding. The upstream receives only the remaining path:

```
Client:   GET /api/v2/users?page=1
Upstream: GET https://api.example.com/users?page=1
                                     ↑ /api/v2 stripped
```

Query strings are preserved and forwarded to the upstream.

If the target ends with a trailing `/`, it is normalized to avoid double-slash paths.

---

## How It Works

The `ProxyHandler` (priority `95`) sits immediately below the middleware layer, making it the first "real" route handler in the pipeline. For each request:

1. It iterates over the `proxy` config keys.
2. If the request path starts with a key, it constructs the upstream URL.
3. It creates a new `Request` to the upstream with the same method, headers, and body (except GET/HEAD, which have no body).
4. It strips the `content-encoding` header from the upstream response to prevent decompression issues.
5. It returns the upstream response verbatim to the client.

---

## Header Forwarding

All client request headers are forwarded to the upstream. This includes:

- `Authorization`
- `Cookie`
- `Content-Type`
- `Accept`
- Custom headers

**Note:** The upstream will see the internal server's IP as the connection source, not the original client's IP. Add an `X-Forwarded-For` header in middleware if your upstream needs the real client IP.

---

## Full Example: Proxying a Vite Dev Server

During development, you may want to proxy certain routes to a Vite dev server running on a different port:

```typescript
// server.config.ts
export default defineConfig({
  root: './src',
  port: 3000,

  proxy: {
    // Forward all /vite/ requests to the Vite dev server
    '/vite': 'http://localhost:5173',
    // Forward GraphQL requests to a separate backend
    '/graphql': 'http://localhost:4000',
  },
})
```

---

## Error Handling

If the upstream is unreachable, Bakery returns:

```
502 Bad Gateway
```

This is returned as a plain text response. If you want a custom error page for proxy failures, use the `onError` hook in `server.config.ts`:

```typescript
export default defineConfig({
  onError(error) {
    if (error.errorCode === 502) {
      return new Response('<h1>The upstream service is unavailable.</h1>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      })
    }
  },
})
```

---

## Route Inspection

Proxy rules are included in the startup route listing:

```
routes   PRX  /api/v2/*   → https://api.example.com
routes   PRX  /legacy/*   → http://localhost:8080
```

---

## Limitations

- The proxy does **not** support WebSocket upgrades on proxied routes. Use Bakery's WebSocket handler API for WebSocket proxying.
- Response body streaming is preserved — large file downloads will stream correctly.
- The proxy does not perform TLS verification bypass. If your upstream uses a self-signed certificate, you may need to configure Bun's TLS settings externally.

---

*[← Middleware](./middleware.md) · [WebSockets →](./websockets.md)*

*[← Back to README](../../README.md)*
