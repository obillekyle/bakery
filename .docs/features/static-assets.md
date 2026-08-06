# Static Asset Serving

Bakery's `StaticHandler` serves files from your `root` directory as static assets. It handles proper MIME types, ETag-based caching, and range requests, ensuring browser caches work efficiently.

---

## How It Works

`StaticHandler` is the lowest-priority handler (priority `0`). It acts as the fallback for any request that was not claimed by a higher-priority handler. When it receives a request, it:

1. Maps the URL path to a file on disk within the `root` directory.
2. Checks that the file exists and is not blocked by the glob blocklist.
3. Generates an **ETag** based on the file's last-modified timestamp and size.
4. Returns a `304 Not Modified` if the client's `If-None-Match` header matches the current ETag.
5. Otherwise, streams the file with appropriate `Content-Type` and `Cache-Control` headers.

---

## ETag Caching

Every file response from Bakery includes an `ETag` header derived from the file's metadata. Subsequent requests send an `If-None-Match` header with the stored ETag. If the file has not changed, Bakery responds with `304 Not Modified` and zero body bytes, saving bandwidth.

```
GET /styles/global.css HTTP/1.1

← HTTP/1.1 200 OK
   ETag: "a4f3b2c1-12345"
   Content-Type: text/css
   Content-Length: 8192

GET /styles/global.css HTTP/1.1
   If-None-Match: "a4f3b2c1-12345"

← HTTP/1.1 304 Not Modified
```

This applies to **all** response types — static files, TSX-rendered HTML, API JSON responses, and image files.

---

## MIME Type Resolution

MIME types are resolved from the file extension using Bun's built-in MIME type database. Common types:

| Extension | MIME Type |
|-----------|-----------|
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js` / `.mjs` | `text/javascript; charset=utf-8` |
| `.ts` | `text/javascript; charset=utf-8` (transpiled) |
| `.json` | *(blocked by default)* |
| `.svg` | `image/svg+xml` |
| `.png` / `.jpg` / `.webp` | `image/png` / `image/jpeg` / `image/webp` |
| `.woff2` | `font/woff2` |
| `.ico` | `image/x-icon` |

---

## Serving CSS Files

CSS files are served directly from disk. In development, when a CSS file changes, Bakery uses the live reload client to **hot-swap the stylesheet** without a full page reload:

1. The file watcher detects a change to a `.css` file.
2. It publishes the filename over the `livereload` WebSocket topic.
3. The browser client finds the matching `<link>` element, fetches the new CSS with a cache-busting query parameter, appends the new `<link>`, and removes the old one after a short delay.

This means CSS changes are instant and **preserve scroll position and JavaScript state**.

---

## HTML Head & Body Injection

Bakery automatically injects configured HTML strings (like stylesheets, scripts, or meta tags) into every HTML response. Injection happens at the response level — the source HTML files do not need to reference these assets.

Configure globally in `server.config.ts`:

```typescript
export default defineConfig({
  head: `
    <link rel="stylesheet" href="/styles/global.css">
    <link rel="stylesheet" href="/styles/theme.css">
    <script src="/script/analytics.js" defer></script>
  `,
  body: `
    <script src="/script/footer.js"></script>
  `,
})
```

In development, Bakery also injects `/_client/livereload.js` automatically.


---

## Image Handler

Images are handled by a dedicated `ImageHandler` (priority `85`), which sits above the generic static handler. It serves images with appropriate headers and can perform basic transformations.

Supported image extensions: `jpg`, `jpeg`, `png`, `gif`, `webp`, `avif`, `svg`, `bmp`, `ico`, `tiff`.

---

## Node Modules Browser Proxy (`/_nm/`)

TypeScript files served to the browser may need to import from `node_modules`. Bakery's `NMHandler` (priority `80`) intercepts requests to `/_nm/*` and maps them to files in `node_modules/`. This allows browser-native ESM imports from npm packages:

```typescript
// In a browser TypeScript file
import { html } from '/_nm/lit-html/lit-html.js'
```

> This feature is primarily intended for development. For production, consider bundling your dependencies.

---

## Path Traversal Protection

Bakery explicitly blocks path traversal attacks. Any path containing `..` or null bytes (`\0`) is rejected with `400 Bad Request` before reaching any handler.

---

*[← Routing](./routing.md) · [API Routes →](./api-routes.md)*

*[← Back to README](../../README.md)*
