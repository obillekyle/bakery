# Introduction & Philosophy

Bakery is a full-stack development server built entirely on [Bun](https://bun.sh). It is designed around one core conviction: **the server should disappear**. You should be able to write a TypeScript file, drop it into a folder, and have it work — no build step, no Webpack config, no HMR plugin to install.

---

## Core Philosophy

### 1. Convention over Configuration

Bakery uses the file system as the primary source of truth for routing. Placing a file in `src/blog/index.tsx` automatically creates a route at `/blog`. Placing a file in `api/users.ts` creates an API endpoint at `/api/users`. You do not register routes manually.

The only file that requires configuration is `server.config.ts`, and most of its fields have sensible defaults.

### 2. TypeScript is a First-Class Citizen

Bun executes TypeScript natively. Bakery extends this by also serving TypeScript and TSX files to the browser after transpiling them on-the-fly using Bun's built-in transpiler. There is no separate compilation pipeline for the client.

### 3. The Dev → Production Gap Should Be Minimal

In development, files are transpiled on request and cached. In production, the same code paths run without the watcher overhead. The API is identical.

### 4. Zero External Runtime Dependencies

Bakery's `package.json` has **zero production `dependencies`**. It relies entirely on Bun's standard library for HTTP serving, SQLite, file watching, WebSockets, and the transpiler. This means no `npm install` for production, no supply-chain surface area.

---

## What Bakery Is Not

- It is **not a framework** like Next.js or Remix. It does not prescribe a React/Vue/Svelte rendering model.
- It is **not a bundler** for production assets. It is a development and lightweight-production server.
- It does **not run PHP** despite the description — it is a Bun-native TypeScript server.

---

## Design Decisions

### Handler Pipeline

Every HTTP request flows through an ordered priority chain of `Handler` classes. Each handler declares `canHandle(path, req)` and `handle(path, req)`. Handlers are registered with a numeric priority, making the chain transparent and extensible. You can insert custom handlers at any priority level.

```
100 → MiddlewareHandler   (user middleware / onRequest hook)
 95 → ProxyHandler        (reverse proxy)
 90 → VirtualAssetHandler (/_client/, /_virtual/)
 85 → ImageHandler        (image processing)
 80 → NMHandler           (node_modules browser proxy)
 70 → ApiHandler          (/api/* routes)
 60 → TSXHandler          (*.tsx server-side rendering)
 55 → TSHandler           (*.ts transpilation)
 50 → HTMLHandler         (*.html pages)
  0 → StaticHandler       (fallback static files)
```

### Tiered Cache

Sessions, compiled assets, and route metadata are stored in a two-tier cache: a bounded LRU in-memory store backed by a SQLite database. When memory eviction occurs, entries are flushed to SQLite. On next access, they are re-hydrated. This means the cache survives soft restarts without cold-start penalty.

### Import Maps + TSConfig Sync

Bakery reads your `importMap` configuration and automatically rewrites `tsconfig.app.json` and `tsconfig.json` path aliases on startup. Your editor's language server and the runtime stay in sync without any manual tsconfig editing.

---

## Who Is Bakery For?

- Developers building **full-stack TypeScript applications** who want a productive local environment without framework lock-in.
- Projects that need **server-rendered HTML or TSX** without a React/Vue hydration lifecycle.
- Teams that want a **lightweight production server** backed by SQLite with zero dependency overhead.

---

## Next Steps

- [Prerequisites & Installation →](./installation.md)
- [Project Structure →](./project-structure.md)

---

*[← Back to README](../../README.md)*
