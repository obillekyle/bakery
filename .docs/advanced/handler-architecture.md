# Handler Architecture

Bakery's HTTP routing is powered by a priority-ordered chain of `Handler` classes. Understanding this architecture allows you to inject custom routing logic, serve new file types, or override default behaviors.

---

## The Handler Pipeline

When an HTTP request arrives, Bakery iterates through all registered handlers in descending priority order. For each handler, it calls `canHandle(path, req)`. The first handler to return `true` "claims" the request, and its `handle(path, req)` method is executed.

If no handler claims the request, a `404 Not Found` response is returned.

### Default Priorities

| Priority | Handler               | Matches                                         |
| -------- | --------------------- | ----------------------------------------------- |
| 100      | `MiddlewareHandler`   | All requests (intercepts for config middleware) |
| 95       | `ProxyHandler`        | Paths matching proxy config                     |
| 90       | `VirtualAssetHandler` | `/_client/*`, `/_virtual/*`                     |
| 85       | `ImageHandler`        | `*.jpg`, `*.png`, etc.                          |
| 80       | `NMHandler`           | `/_nm/*` (Node modules proxy)                   |
| 70       | `ApiHandler`          | `api/*` routes                                  |
| 60       | `TSXHandler`          | `*.tsx` server-side rendering                   |
| 55       | `TSHandler`           | `*.ts` transpilation                            |
| 50       | `HTMLHandler`         | `*.html` pages                                  |
| 0        | `StaticHandler`       | Fallback for everything else                    |

---

## Handler Base Class

All handlers extend the `Handler` base class from `.server/handlers/core/$base.ts`.

### Static Methods to Implement

```typescript
import { Handler } from '@server/handlers/core/$base'

export class CustomHandler extends Handler {
  /**
   * Determine if this handler should process the request.
   * Return a boolean or a Promise<boolean>.
   */
  static canHandle(path: string, req: Request): MixedPromise<boolean> {
    return path.startsWith('/custom/')
  }

  /**
   * Process the request and return a response.
   * Can return a Response, object, string, or undefined.
   */
  static handle(path: string, req: Request): Handler.Response {
    return new Response('Hello from custom handler')
  }

  /**
   * (Optional) Called once on server startup.
   * Use to build static caches or scan directories.
   */
  static initRoutes(): MixedPromise<void> {
    // ...
  }

  /**
   * (Optional) Return metadata for the startup route list console log.
   */
  static routes(): MapOf<Route.Meta> {
    return {
      '/custom/route': { type: 'route', isRoot: false, fileName: 'virtual' },
    }
  }
}
```

---

## DynamicHandler

If your handler relies on matching files in the filesystem (like `ApiHandler`, `TSXHandler`, or `HTMLHandler`), you should extend `DynamicHandler` instead.

`DynamicHandler` provides built-in filesystem scanning, dynamic parameter extraction (e.g., `[id]`), and an LRU cache for route lookups.

### Implementing a DynamicHandler

```typescript
import { DynamicHandler, Route } from '@server/handlers/core/$base'

export class MarkdownHandler extends DynamicHandler {
  /**
   * Configure the filesystem scanner.
   */
  static get config() {
    return {
      ext: ['md'], // File extensions to scan for
      dir: Bakery.serveRoot, // Base directory
      include: ['**/*'], // Glob patterns to include
    }
  }

  /**
   * Process the request. The matched route info is retrieved
   * via `this.resolveRoute(path)`.
   */
  static async handle(path: string, req: Request) {
    const route = await this.resolveRoute(path)
    if (!route) return

    // Read the matched file
    const fileContent = await route.info.file.text()

    // Parse dynamic parameters (from [slug].md)
    const params = await this.params(req, route.params)

    // Convert markdown to HTML...
    const html = renderMarkdown(fileContent)

    return response.html(html)
  }
}
```

Because `MarkdownHandler` extends `DynamicHandler`, it automatically gets `initRoutes()`, `canHandle()`, and `routes()` implemented for you. It handles both static matching (`/about.md`) and dynamic matching (`/docs/[slug].md`).

---

## Registering Custom Handlers

Register your custom handler during the `onStart` hook in `server.config.ts`, or inside a plugin's `setup` hook using `Bakery.handlers.fetch.set()`.

You must provide a priority number. The priority determines where it sits in the pipeline.

```typescript
// server.config.ts
import Bakery from '@server/core/bakery'
import { MarkdownHandler } from './handlers/markdown'

export default defineConfig({
  onStart() {
    // Register below TSX (60) but above HTML (50)
    Bakery.handlers.fetch.set(MarkdownHandler, 58)
  },
})
```

---

## Error Handling Pipeline

Errors thrown by route handlers are caught by a secondary error handler pipeline (`Bakery.errorHandlers`).

Error handler priority:
| Priority | Handler | Purpose |
|----------|---------|---------|
| 100 | `PluginErrorHandler` | Invokes `onError` hooks from plugins/config |
| 50 | `TSXErrorHandler` | Matches `error.tsx` or `error-404.tsx` |
| 40 | `HTMLErrorHandler` | Matches `error.html` or `error-404.html` |
| 30 | `ApiErrorHandler` | Formats API `/api/*` errors as JSON |
| 0 | `DefaultErrorHandler` | Returns plain text `500 Internal Server Error` |

You can register custom error handlers similarly:

```typescript
Bakery.handlers.error.set(MyCustomErrorHandler, 45)
```

Error handlers receive a `Handler.Error.Data` object merged into the `body` parameter.

---

_[← Security Hardening](../deployment/security.md) · [Cache System →](./cache.md)_

_[← Back to README](../../README.md)_
