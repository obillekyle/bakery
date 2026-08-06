# 🍞 Bakery Server

> A ridiculously fast, zero-config full-stack development server built on [Bun](https://bun.sh).

Bakery is an opinionated, batteries-included server runtime that collapses the gap between writing code and running it. It handles TypeScript/TSX transpilation on-the-fly, serves static assets with ETag caching, proxies external APIs, manages sessions, ships a built-in SQLite ORM, and live-reloads the browser — all with a single `bun run .server --dev`.

---

## ✨ Features

| Category       | Feature                                                         | Status |
| -------------- | --------------------------------------------------------------- | ------ |
| **Core**       | Zero-config TypeScript & TSX execution                          | ✅     |
| **Core**       | File-system based routing (static + dynamic `[param]` segments) | ✅     |
| **Core**       | Priority-ordered handler pipeline                               | ✅     |
| **Core**       | Graceful shutdown with registered hooks                         | ✅     |
| **Dev**        | Hot Module Live Reload via WebSocket                            | ✅     |
| **Dev**        | Smart DOM diffing (partial HTML swap, <15% change)              | ✅     |
| **Dev**        | CSS hot-swap without full page reload                           | ✅     |
| **Dev**        | Client-side console log forwarding to server terminal           | ✅     |
| **Dev**        | Spawn logger terminal (press `d`)                               | ✅     |
| **Routing**    | Static asset serving with ETag & cache headers                  | ✅     |
| **Routing**    | API route handler (`/api/**`)                                   | ✅     |
| **Routing**    | HTML page handler with script/style injection                   | ✅     |
| **Routing**    | TSX server-side rendering                                       | ✅     |
| **Routing**    | TypeScript module serving (`*.ts`)                              | ✅     |
| **Routing**    | Image optimization handler                                      | ✅     |
| **Routing**    | Node Modules proxy handler (`/_nm/`)                            | ✅     |
| **Routing**    | Virtual asset compilation (`/_virtual/`, `/_client/`)           | ✅     |
| **Routing**    | Configurable reverse proxy                                      | ✅     |
| **Routing**    | Path blocking via Glob patterns                                 | ✅     |
| **Middleware** | Ordered middleware array                                        | ✅     |
| **Middleware** | `onRequest` global intercept hook                               | ✅     |
| **Sessions**   | Cookie-based sessions with tiered memory/SQLite cache           | ✅     |
| **Sessions**   | Per-key persistence with configurable TTL                       | ✅     |
| **Database**   | Multi-adapter: SQLite (default), PostgreSQL, MySQL              | ✅     |
| **Database**   | Type-safe Query Builder (`DB.QB`)                               | ✅     |
| **Database**   | Schema-driven DDL sync on startup                               | ✅     |
| **Database**   | Automatic rolling backups                                       | ✅     |
| **Cache**      | LRU in-memory cache                                             | ✅     |
| **Cache**      | Tiered memory → SQLite cache with configurable flush            | ✅     |
| **Plugins**    | First-class plugin API with lifecycle hooks                     | ✅     |
| **Plugins**    | Built-in Analytics plugin                                       | ✅     |
| **Plugins**    | Built-in Dashboard plugin (UI + DB browser)                     | ✅     |
| **Config**     | `server.config.ts` with full TypeScript types                   | ✅     |
| **Config**     | Import Map support with auto TSConfig path sync                 | ✅     |
| **Config**     | `.env` / environment variable support                           | ✅     |
| **WebSocket**  | First-class WebSocket handler API                               | ✅     |
| **Security**   | Default path blocking for sensitive files                       | ✅     |
| **Compiler**   | Bun-native transpiler for browser targets                       | ✅     |
| **Compiler**   | CSS/JSON virtual module import rewriting                        | ✅     |

---

## 📁 Documentation

> All documentation lives inside [`.docs/`](.docs/).

### 🚀 Getting Started

- [Introduction & Philosophy](.docs/getting-started/introduction.md)
- [Prerequisites & Installation](.docs/getting-started/installation.md)
- [Project Structure](.docs/getting-started/project-structure.md)

### ⚙️ Configuration

- [server.config.ts Reference](.docs/configuration/server-config.md)
- [Environment Variables](.docs/configuration/environment-variables.md)
- [Import Maps & TSConfig Sync](.docs/configuration/import-maps.md)

### 🏗️ Core Features

- [Routing System](.docs/features/routing.md)
- [Static Asset Serving](.docs/features/static-assets.md)
- [API Routes](.docs/features/api-routes.md)
- [TSX Server-Side Rendering](.docs/features/tsx-rendering.md)
- [Middleware](.docs/features/middleware.md)
- [Reverse Proxy](.docs/features/proxy.md)
- [WebSockets](.docs/features/websockets.md)

### 🔁 Development

- [Live Reload & Hot Module Sync](.docs/development/live-reload.md)
- [Dev Mode Architecture](.docs/development/dev-mode.md)

### 🔐 Sessions

- [Session System](.docs/sessions/sessions.md)

### 🗄️ Database

- [Database Overview](.docs/database/overview.md)
- [Schema Definition](.docs/database/schema.md)
- [Query Builder](.docs/database/query-builder.md)
- [Mutations](.docs/database/mutations.md)
- [Migrations & Schema Sync](.docs/database/migrations.md)

### 🧩 Plugin API

- [Plugin System](.docs/plugins/plugin-api.md)
- [Built-in: Analytics Plugin](.docs/plugins/analytics.md)
- [Built-in: Dashboard Plugin](.docs/plugins/dashboard.md)

### 🚢 Production & Deployment

- [Building for Production](.docs/deployment/production.md)
- [Security Hardening](.docs/deployment/security.md)

### 🛠️ Advanced

- [Handler Architecture](.docs/advanced/handler-architecture.md)
- [Cache System](.docs/advanced/cache.md)
- [Compiler & Virtual Assets](.docs/advanced/compiler.md)

### 📖 Reference

- [CLI Reference](.docs/reference/cli.md)
- [Troubleshooting & FAQ](.docs/reference/troubleshooting.md)

---

## ⚡ Quick Start

```bash
# Install Bun (if not already installed)
curl -fsSL https://bun.sh/install | bash

# Start development server
bun run dev

# Start production server
bun run serve

# Sync database schema
bun run db:sync
```

---

## 📄 License

CC0-1.0 & MIT — see [LICENSE](LICENSE) for details.

_(docs are ai generated and may contain inaccuracies; please verify with the source code)_
