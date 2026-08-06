# Architecture & Folder Structure

Understanding the layouts and core systems of the Bakery server framework.

---

## Workspace Layout
*   `schema.ts` — The source of truth for your database schema, constraint types, and indexes.
*   `server.config.ts` — Framework configuration (routing assets, HTML injections, ports, and active plugins).
*   `api/` — Backend API endpoints. All files mapping routes here are exposed as `/api/*`.
*   `src/` — Client root containing pages, layouts, styles, and client scripts:
    *   `Layout.tsx` — Base page components.
    *   `styles/` — Global and component stylesheets.
    *   `script/` — Client-side scripts.
    *   `[id].html` or `[id].tsx` — Static or server-side JSX dynamic routes.
*   `.server/` — Under-the-hood core engine:
    *   `cache/` — Tiered persistent SQLite caching and LRU.
    *   `client/` — Client utility files (DOM patcher and terminal loggers).
    *   `compiler/` — Hot-restart watchers and browser compilation modules.
    *   `core/` — Server workers, contexts, configurations, and router registries.
    *   `database/` — SQLite/MySQL/PostgreSQL ORM query builders and DDL sync engines.
    *   `handlers/` — HTTP routers, middleware triggers, static assets, error boundaries, and WebSocket upgrades.
    *   `plugins/` — Developer dashboard consoles and real-time analytics aggregators.

---

## Core Systems

### 1. Unified Router & Priority Handlers
Bakery matches routes based on file-system structures. A set of priorities runs from highest to lowest:
1.  **MiddlewareHandler** (100) — Runs request interceptors.
2.  **ProxyHandler** (95) — Forwards prefix routes.
3.  **VirtualAssetHandler** (90) — Serves cached JS/CSS virtual modules.
4.  **ImageHandler** (85) — Serves visual images and icons.
5.  **NMHandler** (80) — Bundles/resolves npm packages from `node_modules` for the browser.
6.  **ApiHandler** (70) — Imports and runs backend endpoints under AsyncLocalStorage request context.
7.  **TSXHandler** (60) — Renders server-side JSX pages.
8.  **TSHandler** (55) — Compiles typescript on-the-fly for the client.
9.  **HTMLHandler** (50) — Template injection on plain HTML files.
10. **StaticHandler** (0) — Default fallback serving raw client files.

### 2. Client-Side Import Maps
The compiler reads package dependencies in `package.json` and injects an `<script type="importmap">` header into all HTML responses. Standard packages are resolved by the server on-the-fly (`/ _nm/*` route proxy) and served as ES modules, allowing client-side files to use clean imports without bundler setup.

### 3. Server-Side JSX Renderer
A lightweight JSX engine compiles elements down to HTML strings on the server. There is zero client overhead. Props are parsed, void tags are handled, and attributes (e.g. `className`, `htmlFor`) are mapped.
