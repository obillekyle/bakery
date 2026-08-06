# Plugin API

Bakery's plugin system allows you to extend server behavior with reusable, self-contained modules. Plugins are registered in `server.config.ts` and participate in a set of well-defined lifecycle hooks.

---

## Plugin Interface

A plugin is any object that implements the `ServerPlugin` interface:

```typescript
interface ServerPlugin {
  /** Display name for logging */
  name: string

  /** Called once on startup, before any handlers are initialized */
  setup?(config: ProcessedAppConfig): MixedPromise<void>

  /** Called after the server starts listening */
  onStart?(server: Bun.Server): MixedPromise<void>

  /** Called for every request, before route handlers */
  onRequest?(req: Request): ValidResponses

  /** Called for every request (side-effect only, no response) */
  onRoute?(req: Request): MixedPromise<void>

  /** Called when a handler returns an error response */
  onError?(error: Handler.Error.Data, req?: Request): ValidResponses

  /** Called during graceful shutdown */
  onShutdown?(): MixedPromise<void>
}
```

Where `ValidResponses` is:

```typescript
type ValidResponses = Response | object | string | void | undefined | null
```

---

## Creating a Plugin

### Using `definePlugin`

```typescript
import { definePlugin } from '@server/plugins/types'

const myPlugin = definePlugin({
  name: 'my-plugin',

  setup(config) {
    console.log(`[my-plugin] Setting up with root: ${config.root}`)
  },

  onStart(server) {
    console.log(`[my-plugin] Server started on port ${server.port}`)
  },

  onRequest(req) {
    // Add a header to every response... (via wrapping, if needed)
    // Or return a Response to short-circuit routing:
    if (req.url.includes('/__blocked')) {
      return new Response('Forbidden', { status: 403 })
    }
  },

  onRoute(req) {
    // Side effects on every request (analytics, logging, etc.)
    // Cannot return a response — use onRequest for that
  },

  onError(error, req) {
    console.error(`[my-plugin] Error ${error.errorCode}: ${error.errorBody}`)
    // Return a Response to use a custom error page
  },

  onShutdown() {
    console.log('[my-plugin] Cleaning up...')
  },
})

export default myPlugin
```

### Using `PluginBase` Class

For class-based plugins with shared state:

```typescript
import { PluginBase } from '@server/plugins/types'

class MetricsPlugin extends PluginBase {
  name = 'metrics'
  private requestCount = 0

  onRoute(req: Request) {
    this.requestCount++
  }

  onStart(server: Bun.Server) {
    setInterval(() => {
      console.log(`[metrics] Requests in last minute: ${this.requestCount}`)
      this.requestCount = 0
    }, 60_000)
  }

  onShutdown() {
    console.log(`[metrics] Final count: ${this.requestCount}`)
  }
}

export default () => new MetricsPlugin()
```

---

## Registering Plugins

Add plugins to the `plugins` array in `server.config.ts`:

```typescript
import { defineConfig } from '@server/core'
import myPlugin from './plugins/my-plugin'
import analyticsPlugin from '@plugins/analytics'
import dashboardPlugin from '@plugins/dashboard'

export default defineConfig({
  plugins: [
    dashboardPlugin(),
    analyticsPlugin(),
    myPlugin, // can be an instance or a factory function result
  ],
})
```

Plugins are executed in order for each lifecycle hook.

---

## Lifecycle Hook Details

### `setup(config)`

Called once, before handler routes are initialized. Use this to:

- Read configuration and validate it.
- Register custom handlers via `Bakery.handlers.fetch.set()`.
- Initialize external connections or resources.

```typescript
setup(config) {
  if (!process.env.STRIPE_KEY) {
    throw new Error('STRIPE_KEY environment variable is required')
  }
  Bakery.handlers.fetch.set(MyPaymentHandler, 75)
}
```

### `onRequest(req)`

Called for every incoming request, before any route handler. Runs after the `middleware` array in `server.config.ts`. If it returns a `Response`, routing stops.

Multiple plugins with `onRequest` are called in order. The first non-null response short-circuits the chain.

### `onRoute(req)`

Called for every request but cannot return a response. Use for side effects only: analytics tracking, access logging, cache warming.

### `onError(error, req)`

Called when an unhandled error occurs in a handler. Receives the error data object and the original request. Return a `Response` to override the default error page.

```typescript
onError(error, req) {
  if (error.errorCode >= 500) {
    // Alert your error tracking service
    fetch('https://errors.example.com/report', {
      method: 'POST',
      body: JSON.stringify({ error, url: req?.url }),
    }).catch(() => {})
  }
}
```

### `onShutdown()`

Called during graceful server shutdown, after `Bakery.shutdownHooks` but before the process exits. Use to flush buffers, close connections, or persist state.

---

## Accessing the Config Inside a Plugin

```typescript
const myPlugin = definePlugin({
  name: 'config-aware',
  setup(config) {
    // config is the fully resolved ProcessedAppConfig
    const port = config.port // number
    const root = config.root // string (absolute path)
    const proxy = config.proxy // Record<string, string>
  },
})
```

---

## Plugin Error Handling

If a plugin's lifecycle hook throws, Bakery logs the error and continues (it does not crash the server). For `onRequest`, an unhandled exception returns a `500 Internal Server Error`.

```
[server] PLUGIN_ERROR  analytics.onRoute → TypeError: Cannot read properties of null
```

---

## Example: CORS Plugin

```typescript
// plugins/cors.ts
import { definePlugin } from '@server/plugins/types'

interface CORSOptions {
  origins?: string | string[]
  methods?: string[]
  headers?: string[]
}

export default function corsPlugin(options: CORSOptions = {}) {
  const {
    origins = '*',
    methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    headers = ['Content-Type', 'Authorization'],
  } = options

  const allowOrigin = Array.isArray(origins) ? origins.join(', ') : origins

  return definePlugin({
    name: 'cors',

    onRequest(req) {
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': allowOrigin,
            'Access-Control-Allow-Methods': methods.join(', '),
            'Access-Control-Allow-Headers': headers.join(', '),
            'Access-Control-Max-Age': '86400',
          },
        })
      }
    },
  })
}
```

```typescript
// server.config.ts
import corsPlugin from './plugins/cors'

export default defineConfig({
  plugins: [
    corsPlugin({
      origins: ['https://app.example.com', 'http://localhost:5173'],
    }),
  ],
})
```

---

_[← Migrations](../database/migrations.md) · [Analytics Plugin →](./analytics.md)_

_[← Back to README](../../README.md)_
