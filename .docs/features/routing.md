# Routing System

Bakery uses a file-system based routing model. The file tree under your configured `root` directory defines the URL surface of your application — no route registration is needed.

---

## How Routing Works

When a request arrives, Bakery passes it through an ordered pipeline of `Handler` classes. Each handler implements a `canHandle(path, req)` method. The first handler that returns `true` from `canHandle` processes the request.

The handler pipeline priority is:

| Priority | Handler               | Matches                                      |
| -------- | --------------------- | -------------------------------------------- |
| 100      | `MiddlewareHandler`   | All requests (if middleware configured)      |
| 95       | `ProxyHandler`        | Paths matching `proxy` config keys           |
| 90       | `VirtualAssetHandler` | `/_client/*`, `/_virtual/*`                  |
| 85       | `ImageHandler`        | Image files (jpg, png, gif, webp, svg, etc.) |
| 80       | `NMHandler`           | `/_nm/*` (node_modules browser proxy)        |
| 70       | `ApiHandler`          | `/api/*`                                     |
| 60       | `TSXHandler`          | `*.tsx` routes in serve root                 |
| 55       | `TSHandler`           | `*.ts` files in serve root                   |
| 50       | `HTMLHandler`         | `*.html` pages in serve root                 |
| 0        | `StaticHandler`       | Everything else (CSS, fonts, images, etc.)   |

---

## Static Routes

A file named `index.html` in a directory maps to both the directory path and the explicit file path:

```
src/
├── index.html          → GET /  and  GET /index.html
├── about.html          → GET /about  and  GET /about.html
└── blog/
    └── index.html      → GET /blog/  and  GET /blog/index.html
```

---

## Dynamic Route Segments

Bakery supports dynamic path parameters using square-bracket syntax in file names. The segment name is extracted and made available in the request body.

```
src/
├── blog/
│   └── [slug].tsx      → GET /blog/hello-world → body.slug = "hello-world"
├── users/
│   └── [id]/
│       └── index.html  → GET /users/42 → body.id = "42"
└── api/
    └── [resource].ts   → /api/posts → body.resource = "posts"
```

### Accessing Parameters

Parameters are merged into the `body` object passed to TSX and API handlers:

```typescript
// src/blog/[slug].tsx
export default function(req: Request, body: { slug: string }) {
  return <article>
    <h1>Post: {body.slug}</h1>
  </article>
}
```

```typescript
// api/[resource].ts
export default function (req: Request, body: { resource: string }) {
  return { resource: body.resource, method: req.method }
}
```

---

## URL Resolution Rules

Bakery resolves URLs to files using the following lookup order (using `*.tsx` as an example):

1. Exact path match: `/blog` → `src/blog.tsx`
2. Index file: `/blog` → `src/blog/index.tsx`
3. Extension-explicit: `/blog.tsx` → `src/blog.tsx`
4. Dynamic match: `/blog/hello-world` → `src/blog/[slug].tsx`

The same logic applies to `.html`, `.ts`, and static file handlers.

---

## File Extension Handling

| Extension                     | Handler       | Notes                                                |
| ----------------------------- | ------------- | ---------------------------------------------------- |
| `.html`                       | HTMLHandler   | HTML injection (scripts, styles, livereload) applied |
| `.tsx`                        | TSXHandler    | Server-executed, returns HTML or JSON                |
| `.ts`                         | TSHandler     | Transpiled and served as JavaScript                  |
| `.css`                        | StaticHandler | Served as-is with `content-type: text/css`           |
| `.js`, `.mjs`                 | StaticHandler | Served as-is                                         |
| `.jpg`, `.png`, `.webp`, etc. | ImageHandler  | Served with optimized headers                        |
| `.json`, `.yaml`, `.yml`      | **Blocked**   | Returns 403                                          |
| `.env`, `.db`, `.sql`         | **Blocked**   | Returns 403                                          |

---

## Error Routing

Bakery also supports file-based error pages. These files are matched by the error handler pipeline when a request results in an error:

| File                  | Matched For                                    |
| --------------------- | ---------------------------------------------- |
| `src/error.html`      | Generic 5xx errors                             |
| `src/error-404.html`  | 404 Not Found errors                           |
| `src/error-*.html`    | Wildcard error pages (e.g., `error-403.html`)  |
| `src/error.tsx`       | TSX error page (receives error data in `body`) |
| `src/[dir]/error.tsx` | Directory-scoped error page                    |

Error TSX pages receive the following properties in their `body` argument:

```typescript
type ErrorBody = {
  errorCode: number // e.g., 404
  errorText: string // e.g., "Not Found"
  errorBody: string // e.g., "The page you requested could not be found."
}
```

---

## Route Listing on Startup

When the server starts, Bakery logs all discovered routes grouped by handler type. This output looks like:

```
[I] routes
[I] routes          Endpoints (/api)
[I] routes          ├─ _analytics
[I] routes          │   ├─ ping (virtual)
[I] routes          │   ├─ reset (virtual)
[I] routes          │   └─ stats (virtual)
[I] routes          ├─ _dashboard
[I] routes          │   ├─ sessions
[I] routes          │   │   ├─ /_virtual
[I] routes          │   │   ├─ delete (virtual)
[I] routes          │   │   └─ update (virtual)
[I] routes          │   ├─ execute-action (virtual)
[I] routes          │   ├─ query (virtual)
[I] routes          │   ├─ routes (virtual)
[I] routes          │   ├─ schema (virtual)
[I] routes          │   └─ table-data (virtual)
[I] routes          ├─ env-test.ts
[I] routes          ├─ hello.ts
[I] routes          └─ test-session.ts
[I] routes          Pages
[I] routes          ├─ /index.html
[I] routes          ├─ _client
[I] routes          │   ├─ livereload.js
[I] routes          │   └─ utils.js
[I] routes          ├─ _dashboard
[I] routes          │   ├─ /dashboard.tsx
[I] routes          │   ├─ dashboard.js
[I] routes          │   └─ style.css
[I] routes          ├─ _virtual
[I] routes          │   └─ *(virtual)
[I] routes          ├─ blog
[I] routes          │   ├─ [id].html
[I] routes          │   ├─ existing.tsx
[I] routes          │   ├─ existing.html
[I] routes          │   └─ error.html
[I] routes          ├─ blog-jsx
[I] routes          │   └─ [id].tsx
[I] routes          ├─ script
[I] routes          │   └─ index.ts
[I] routes          ├─ jsx.tsx
[I] routes          ├─ Layout.tsx
[I] routes          ├─ session.tsx
[I] routes          ├─ error-404.html
[I] routes          └─ error.html
```

---

## Registering a Custom Handler

You can extend the pipeline with your own handler class:

```typescript
// .server/handlers/routes/my-handler.ts
import { Handler } from '../core/$base'

export class MyHandler extends Handler {
  static canHandle(path: string, req: Request) {
    return path.startsWith('/custom/')
  }

  static handle(path: string, req: Request) {
    return new Response(`Custom handler matched: ${path}`)
  }
}
```

Register it in `server.config.ts` via `onStart`, or in a plugin's `onStart` hook:

```typescript
// In a plugin or onStart hook
import { Bakery } from '@server/core/bakery'
import { MyHandler } from './.server/handlers/routes/my-handler'

Bakery.handlers.fetch.set(MyHandler, 65) // priority between TSXHandler (60) and ApiHandler (70)
```

See [Handler Architecture →](../advanced/handler-architecture.md) for the full handler API.

---

_[← Import Maps](../configuration/import-maps.md) · [Static Asset Serving →](./static-assets.md)_

_[← Back to README](../../README.md)_
