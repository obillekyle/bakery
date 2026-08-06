# Bakery

A full-stack framework for [Bun](https://bun.sh): file-system routing,
server-rendered JSX, a typed ORM with schema sync, and a plugin system — with no
build step in development.

> **These docs replace the previous `.docs/` tree, which was withdrawn.** An
> audit found definite factual errors in 33 of its 34 files: it documented a
> package layout, a dashboard auth model and a query API that no longer existed,
> and none of its code examples would run. Every TypeScript example here is
> compiled against the real packages by `tests/docs-examples.test.ts`, so an
> example that stops working fails the build rather than the reader.

## Getting started

- [Installation](getting-started/installation.md)
- [Your first app](getting-started/first-app.md)
- [Project structure](getting-started/project-structure.md)

## Guides

- [Routing](guides/routing.md) — how a URL becomes a file
- [API routes](guides/api-routes.md) — JSON endpoints, request bodies, CSRF
- [Middleware](guides/middleware.md)
- [Static assets](guides/static-assets.md)
- [Proxy](guides/proxy.md)
- [WebSockets](guides/websockets.md)
- [Sessions](guides/sessions.md)

## Configuration

- [server.config.ts](configuration/server-config.md) — the full option surface
- [Multi-host](configuration/multi-host.md) — per-hostname config
- [Environment](configuration/environment.md)

## Database

- [Schema](orm/schema.md) — declaring tables
- [Queries](orm/queries.md)
- [Mutations](orm/mutations.md)
- [Schema sync](orm/sync.md) — `db:sync`, and what it will refuse to do
- [Adapters](orm/adapters.md) — SQLite, MySQL, Postgres

## Plugins

- [Plugin API](plugins/plugin-api.md) — writing one
- [Vue](plugins/vue.md)
- [Analytics](plugins/analytics.md)
- [Dashboard](plugins/dashboard.md)

## Deployment

- [Production](deployment/production.md)
- [Security](deployment/security.md)

## Reference

- [CLI](reference/cli.md)
- [Architecture](reference/architecture.md) — the request pipeline

## Packages

| Package | Contents |
| --- | --- |
| `@bakery/core` | handlers, router, config, sessions, caches, logger, compiler |
| `@bakery/orm` | query builder, mutations, adapters, schema sync, backup |
| `@bakery/cli` | the `bakery` binary: dev, serve, cluster, mode dispatch |
| `@bakery/plugin-vue` | `.vue` single-file components with server blocks |
| `@bakery/plugin-analytics` | request telemetry collection |
| `@bakery/plugin-dashboard` | the built-in admin console |
