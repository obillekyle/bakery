# server.config.ts Reference

`server.config.ts` is the single configuration file for Bakery. It must live at the project root (alongside `package.json`) and export a default object created with the `defineConfig` helper.

---

## Minimal Example

```typescript
// server.config.ts
import { defineConfig } from '@server/core'

export default defineConfig({
  root: './src',
  port: 3000,
})
```

---

## Full Annotated Example

```typescript
// server.config.ts
import { defineConfig } from '@server/core'
import analyticsPlugin from '@plugins/analytics'
import dashboardPlugin from '@plugins/dashboard'

export default defineConfig({
  // ─────────────────────────────────────────────
  // Server Binding
  // ─────────────────────────────────────────────

  /**
   * The port to listen on.
   * Can be overridden at runtime via the PORT environment variable.
   * @default 3000
   */
  port: 3000,

  /**
   * The hostname/IP to bind to.
   * '0.0.0.0' listens on all interfaces (exposes to LAN).
   * '127.0.0.1' restricts to localhost only.
   * @default '0.0.0.0'
   */
  host: '0.0.0.0',

  // ─────────────────────────────────────────────
  // Application Root
  // ─────────────────────────────────────────────

  /**
   * Absolute or relative path to the directory that Bakery
   * treats as the web root. All static files, HTML pages,
   * and TSX routes are resolved relative to this directory.
   * @default process.cwd()
   */
  root: './src',

  // ─────────────────────────────────────────────
  // Asset Injection
  // ─────────────────────────────────────────────

  /**
   * HTML string to inject into the <head> of every HTML response.
   *
   * @example
   * head: '<link rel="stylesheet" href="/styles/global.css">',
   * @default ''
   */
  head: '',

  /**
   * HTML string to inject before the closing </body> tag of every HTML response.
   *
   * @example
   * body: '<script src="/script/analytics.js"></script>',
   * @default ''
   */
  body: '',

  // ─────────────────────────────────────────────
  // Reverse Proxy
  // ─────────────────────────────────────────────

  /**
   * Map of URL prefixes to upstream targets.
   * When a request path starts with a key, the request is
   * transparently forwarded to the corresponding URL.
   *
   * The prefix is stripped from the path before forwarding.
   *
   * @example
   * proxy: {
   *   '/api/v2': 'https://api.example.com',
   *   '/cdn': 'https://assets.cdn.com',
   * }
   * @default {}
   */
  proxy: {
    '/legacy': 'http://localhost:8080',
  },

  // ─────────────────────────────────────────────
  // Request Limits
  // ─────────────────────────────────────────────

  /**
   * Maximum allowed size (in bytes) for incoming request bodies.
   * Requests exceeding this limit are rejected with 413.
   * @default 20971520 (20 MB)
   */
  maxBodySize: 20 * 1024 * 1024,

  /**
   * Maximum number of entries to hold in the in-memory LRU
   * route cache per handler.
   * @default 500
   */
  maxCacheSize: 500,

  // ─────────────────────────────────────────────
  // Security: Path Blocking
  // ─────────────────────────────────────────────

  /**
   * Additional glob patterns to block. These are merged with
   * the default blocked patterns (see Project Structure docs).
   * Patterns that don't start with '**\/' are automatically prefixed.
   *
   * @example blocked: ['private/**', 'secrets.json']
   * @default []
   */
  blocked: [
    'private/**',
  ],

  // ─────────────────────────────────────────────
  // Import Maps
  // ─────────────────────────────────────────────

  /**
   * Browser-side import map entries. Keys are bare specifiers,
   * values are paths (relative to project root or serve root).
   *
   * On startup, Bakery automatically syncs these into
   * tsconfig.app.json and tsconfig.json so your editor's
   * language server sees the same paths.
   *
   * The entry '@client/utils' → '.server/client/utils' is
   * always included and cannot be removed.
   *
   * @example
   * importMap: {
   *   '@components': 'src/components',
   *   '@utils': 'src/lib/utils',
   * }
   * @default { '@client/utils': '.server/client/utils' }
   */
  importMap: {
    '@components': 'src/components',
  },

  // ─────────────────────────────────────────────
  // Middleware
  // ─────────────────────────────────────────────

  /**
   * An ordered array of middleware functions. Each middleware
   * receives the raw Request and the Bun.Server instance.
   *
   * Return a Response to short-circuit the handler pipeline.
   * Return void/undefined to pass to the next middleware.
   *
   * Middleware runs before all route handlers (priority 100).
   */
  middleware: [
    async (req, server) => {
      // Example: add a CORS header to all responses
      // Note: modify the response after the fact via onRequest instead
      if (req.headers.get('origin')) {
        // return a Response to short-circuit
      }
    },
  ],

  // ─────────────────────────────────────────────
  // WebSocket (optional — for raw WS handling)
  // ─────────────────────────────────────────────

  /**
   * Raw WebSocket event handlers. These are invoked for WebSocket
   * connections that are NOT handled by a WebSocketHandler class.
   * If you create a WebSocketHandler subclass, use that instead.
   */
  websocket: {
    message(ws, message) {
      ws.send(`Echo: ${message}`)
    },
    open(ws) {
      console.log('WS opened:', ws.remoteAddress)
    },
    close(ws, code, reason) {
      console.log('WS closed:', code, reason)
    },
    drain(ws) {},
  },

  // ─────────────────────────────────────────────
  // Plugins
  // ─────────────────────────────────────────────

  /**
   * Array of ServerPlugin instances to register.
   * Plugins are executed in order for each lifecycle hook.
   * @see .docs/plugins/plugin-api.md
   */
  plugins: [
    dashboardPlugin(),
    analyticsPlugin(),
  ],

  // ─────────────────────────────────────────────
  // Database
  // ─────────────────────────────────────────────

  /**
   * Number of automatic rolling backups to keep of the SQLite
   * database. Older backups are pruned automatically.
   * @default 10
   */
  backups: 10,

  // ─────────────────────────────────────────────
  // Lifecycle Hooks
  // ─────────────────────────────────────────────

  /**
   * Called once after the server has started and all handlers
   * are initialized. Use this for post-startup side effects
   * (e.g., seeding a database, logging startup metrics).
   */
  async onStart() {
    console.log('Bakery is ready!')
  },

  /**
   * Called on every incoming request, before any handler
   * processes it. Return a Response to short-circuit the
   * pipeline entirely. Return void to proceed normally.
   *
   * This runs at priority 100 (same as middleware array),
   * before ProxyHandler, ApiHandler, etc.
   */
  async onRequest(req) {
    const token = req.headers.get('x-api-token')
    if (req.url.includes('/admin') && !token) {
      return new Response('Unauthorized', { status: 401 })
    }
  },

  /**
   * Called when any handler throws an unhandled error.
   * Receives a normalized error data object.
   * Return a Response to override the default error page.
   * Return void to fall through to the default error handlers.
   */
  async onError(error) {
    console.error(`[${error.errorCode}] ${error.errorBody}`)
    // Return a Response to use a custom error page:
    // return new Response(myErrorPage, { status: error.errorCode })
  },

  /**
   * Called during server shutdown (SIGINT / SIGTERM).
   * Use this to flush data, close connections, or log analytics.
   */
  async onShutdown() {
    console.log('Server shutting down...')
  },
})
```

---

## TypeScript Type Reference

The full `AppConfig` type is defined in `.server/global.d.ts`:

```typescript
type AppConfig = {
  root?: string
  port?: number
  host?: string
  importMap?: Record<string, string>
  backups?: number
  proxy?: Record<string, string>
  head?: string
  body?: string
  onStart?(): MixedPromise<void>
  onRequest?(req: Request): MixedPromise<any>
  onError?(error: Handler.Error.Data): MixedPromise<any>
  onShutdown?(): MixedPromise<void>
  middleware?: ((req: Request, server: Bun.Server) => MixedPromise<Response | void>)[]
  plugins?: ServerPlugin[]
  websocket?: Bun.WebSocketHandler<any>
  maxBodySize?: number
  maxCacheSize?: number
  blocked?: string[]
}
```

---

## `defineConfig`

`defineConfig` is a pass-through identity function that provides full TypeScript autocompletion for the configuration object. It performs no runtime transformation.

```typescript
import { defineConfig } from '@server/core'

export default defineConfig({ /* ... */ })
```

---

*[← Project Structure](../getting-started/project-structure.md) · [Environment Variables →](./environment-variables.md)*

*[← Back to README](../../README.md)*
