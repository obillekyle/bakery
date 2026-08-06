# Project Structure

A freshly initialized Bakery project has the following layout. Understanding this structure is essential, as most of Bakery's conventions derive from it.

---

```
bakery-app/
│
├── .server/                  # Bakery runtime internals (do not edit unless extending)
│   ├── cache/                # LRU and tiered cache implementations
│   ├── client/               # Browser-side scripts (livereload, utils)
│   ├── compiler/             # Bun transpiler + file watcher / dev service
│   ├── core/                 # Server bootstrap, router, session, plugin runner
│   ├── database/             # ORM, query builder, schema sync, adapters
│   ├── handlers/             # All request handler classes
│   │   ├── assets/           # Image, TS, TSX, Static, Virtual, NM handlers
│   │   ├── core/             # Handler base class, error handler, WS handler
│   │   └── routes/           # API, HTML, Proxy, LiveReload handlers
│   ├── logger/               # Structured logger + serve log
│   ├── plugins/              # Built-in plugins (analytics, dashboard)
│   ├── utils/                # HTTP helpers, routing utils, fs utils, constants
│   ├── global.d.ts           # Global TypeScript declarations
│   ├── index.ts              # Entry point (routes to dev master or worker)
│   └── worker.ts             # HTTP server worker (Bun.serve)
│
├── src/                      # Your application root (configured via `root`)
│   ├── index.html            # Homepage — served at /
│   ├── error.html            # Custom 500 error page
│   ├── error-404.html        # Custom 404 error page
│   ├── styles/               # CSS files
│   │   └── global.css
│   ├── script/               # TypeScript client-side scripts
│   ├── images/               # Static images
│   ├── blog/                 # Directory route → /blog
│   │   └── index.tsx         # Server-rendered TSX → GET /blog
│   └── [id]/                 # Dynamic route segment
│       └── index.tsx         # → /anything → req.body.id = "anything"
│
├── api/                      # API endpoint directory
│   ├── hello.ts              # → GET/POST /api/hello
│   └── [resource].ts         # → /api/:resource (dynamic)
│
├── schema.ts                 # Database schema definition
├── server.config.ts          # Server configuration
├── package.json
├── tsconfig.json
├── tsconfig.app.json         # Auto-synced by Bakery for client-side paths
├── tsconfig.server.json
├── .env                      # Local environment variables
└── .env.example              # Example env template
```

---

## Key Directories

### `.server/` — The Runtime

This is Bakery's engine. You will rarely need to modify files here unless you are extending Bakery with custom handlers or plugins. The internal structure is documented in the [Handler Architecture guide](../advanced/handler-architecture.md).

The `.server/` directory is **blocked by default** from being served to clients. Requests to any path matching `**/.server/**` return `403 Forbidden`.

### `src/` — Your Application Root

The `src/` directory (or whatever path you configure as `root` in `server.config.ts`) is the root from which Bakery serves your application. Files placed here are accessible as URL paths:

| File | URL |
|------|-----|
| `src/index.html` | `GET /` or `GET /index.html` |
| `src/about.html` | `GET /about` or `GET /about.html` |
| `src/blog/index.tsx` | `GET /blog` |
| `src/blog/[slug].tsx` | `GET /blog/my-post` → `body.slug = "my-post"` |
| `src/styles/global.css` | `GET /styles/global.css` |

### `api/` — API Endpoints

Files in the `api/` directory are mounted at the `/api/` URL prefix. They must export a default function (or value):

```typescript
// api/hello.ts
export default function(req: Request, body: Record<string, any>) {
  return { message: 'Hello, world!', method: req.method }
}
```

This file is accessible at `GET /api/hello` and `POST /api/hello`. See [API Routes →](../features/api-routes.md).

### `schema.ts` — Database Schema

Defines your SQLite/PostgreSQL/MySQL table structure using Bakery's schema builder. This file is read on startup and used to sync the database schema automatically. See [Schema Definition →](../database/schema.md).

---

## Blocked Paths

The following path patterns are blocked from being served to clients by default. Requests matching them receive a `403 Forbidden` response:

```
**/.env           **/*.env
**/*.sql          **/*.db
**/*.json         **/*.yaml / **/*.yml
**/*.lock         **/.server/**
**/_internal/**   **/.git/**
**/.vscode/**     **/node_modules/**
**/server.config.ts
**/schema.ts
**/.gitignore     **/*.exe
```

You can add additional blocked patterns in `server.config.ts` via the `blocked` option. You cannot remove the defaults.

---

## Internal URL Namespace

Bakery reserves the following URL prefixes for internal use:

| Prefix | Purpose |
|--------|---------|
| `/_livereload` | WebSocket endpoint for Hot Reload |
| `/_client/livereload.js` | Injected live reload client script |
| `/_client/utils.js` | Injected Bakery client utilities |
| `/_virtual/*` | Compiled virtual assets (CSS/JSON imports) |
| `/_nm/*` | Browser-proxied node_modules |
| `/_dashboard` | Built-in Dashboard plugin UI |

---

## Configuration Files

| File | Purpose |
|------|---------|
| `server.config.ts` | Main server configuration |
| `tsconfig.json` | Root TypeScript config (auto-synced paths) |
| `tsconfig.app.json` | Client-facing TypeScript paths (auto-synced) |
| `tsconfig.server.json` | Server-side TypeScript config |
| `.env` | Runtime environment variables |

---

*[← Installation](./installation.md) · [server.config.ts Reference →](../configuration/server-config.md)*

*[← Back to README](../../README.md)*
