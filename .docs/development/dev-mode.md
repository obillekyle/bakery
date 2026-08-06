# Dev Mode Architecture

Understanding Bakery's development mode architecture helps you debug startup issues, understand file watch behavior, and extend the system.

---

## Process Model

Development mode uses a **two-process architecture**:

```
bun run .server --dev
        │
        └─ dev master (handleDevMaster)
               │
               ├─ Spawns: bun --smol .server/worker.ts --dev --dev-worker
               │                    ↑
               │                    HTTP server worker
               │
               ├─ On exit code 42:  restart worker (backend change)
               ├─ On exit code 130: graceful exit (Ctrl+C)
               └─ On other codes:   propagate exit code
```

### Dev Master

The master process (`handleDevMaster` in `dev-service.ts`) is a thin supervisor that:

- Spawns the worker subprocess with `bun --smol` (reduced memory mode).
- Listens for keyboard input (`s` = stop, `d` = logger terminal, `Ctrl+C` = kill).
- Restarts the worker when it exits with code `42`.
- Passes `DEV_WATCHER_ACTIVE=1` to the worker's environment.

The master process does **not** run the HTTP server. It never touches `Bun.serve`.

### Worker

The worker (`worker.ts`) is the actual HTTP server. It:

1. Runs the full startup sequence (config init, DB schema sync, handler setup).
2. Starts `Bun.serve` with the request handler.
3. Starts the file watcher (`startCompileService`).
4. On backend file changes: exits with code `42` (triggers master restart).
5. On frontend file changes: publishes to `livereload` topic.
6. On SIGINT/SIGTERM: runs shutdown hooks and exits with code `0`.

---

## Startup Sequence

When the worker starts, it executes these steps in order:

```
1. startup()
   ├─ initConfig()         → load server.config.ts, merge defaults
   ├─ initImportMap()      → build import map HTML snippet
   ├─ syncTSConfigPaths()  → write tsconfig.app.json paths
   └─ syncSQLSchema()      → diff and apply database schema changes

2. setupServer()
   ├─ LiveReloadHandler.init()
   ├─ Register all handlers (error, fetch, websocket) with priorities
   └─ setupPlugins()       → call plugin.setup() for each plugin

3. initRoutes()            → scan file system, populate route caches

4. Bun.serve()             → start HTTP server

5. startCompileService()   → start file watcher (dev worker only)

6. runStartupBanner()      → log server URLs and call onStart hooks

7. printStartupRoutes()    → log route tree
```

---

## Environment Flags

| Flag | Set When |
|------|----------|
| `import.meta.env.DEV` | `--dev` flag is present |
| `import.meta.env.PROD` | `--dev` flag is absent |
| `import.meta.env.WORKER` | Running as the worker subprocess (`--dev-worker`) |
| `import.meta.env.MODE` | `'development'`, `'production'`, or `'dev-worker'` |

These flags are used inside Bakery to conditionally enable features:

```typescript
// Live reload only in dev worker:
if (import.meta.env.WORKER) {
  startCompileService(server)
}

// LiveReloadHandler only in dev worker:
static canHandle(path: string) {
  if (!import.meta.env.WORKER) return false
  return path === '/_livereload'
}
```

They are also inlined into compiled browser scripts by the transpiler:

```typescript
// Before compilation (browser script):
if (import.meta.env.DEV) {
  console.log('dev mode')
}

// After compilation in production:
// (the entire block is dead code eliminated)
```

---

## File Watch Event Classification

The watcher in `startCompileService` classifies every file change event:

```
File changed
    │
    ├─ Ignored? (node_modules, .git, etc.)  → skip
    ├─ Not a tracked extension?              → skip
    ├─ package.json / bun.lock?             → log "deps changed" notice
    ├─ Backend file? (*.tsx, api/**, .server/**, server.config.ts, schema.ts)
    │       └─ In dev worker?               → exit(42) → master restarts
    ├─ Frontend file? (*.ts, *.js, *.css, *.html)
    │       └─ In dev worker?               → publish to livereload topic
    └─ File deleted?
            └─ In dev worker?               → publish to livereload topic
```

---

## Console Clear on Restart

When the worker restarts (exit code 42), the master process calls `console.clear()` before spawning the new worker. This clears the terminal and gives the new startup log a clean slate.

---

## Testing Mode

When `NODE_ENV=test`, Bakery's `Bun.serve` binds to port `0` (OS-assigned ephemeral port). This allows multiple test suites to run concurrently without port collisions.

```typescript
const port = isTest ? 0 : Bakery.config.port
```

Retrieve the actual bound port from `Bakery.server.port` after startup.

---

## Production Differences

| Feature | Development | Production |
|---------|------------|------------|
| Dev master supervisor | ✅ Yes | ❌ No |
| File watcher | ✅ Yes | ❌ No |
| Live reload WebSocket | ✅ Yes | ❌ No |
| Script minification | ❌ No | ✅ Yes |
| `import.meta.env.DEV` | `true` | `false` |
| `--smol` memory mode | ✅ Yes (worker) | ❌ No |
| Console clear on restart | ✅ Yes | ❌ No |

---

*[← Live Reload](./live-reload.md) · [Session System →](../sessions/sessions.md)*

*[← Back to README](../../README.md)*
