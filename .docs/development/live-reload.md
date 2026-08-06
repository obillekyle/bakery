# Live Reload & Hot Module Sync

Bakery's development mode features a sophisticated live reload system that minimizes interruptions while you code. It uses a WebSocket connection to push file change notifications to the browser, and applies intelligent patching strategies based on the type of change detected.

---

## How It Works

The system consists of three coordinated pieces:

1. **File Watcher** (server, `.server/compiler/dev-service.ts`) — Watches the project directory for changes using Node.js `fs.watch` with `recursive: true`.
2. **WebSocket Server** (server, `.server/handlers/routes/livereload.ts`) — Publishes change notifications over the `livereload` Bun pub/sub topic.
3. **Live Reload Client** (browser, `.server/client/livereload.ts`) — Listens for WebSocket messages and applies the appropriate update strategy.

---

## Update Strategies

The browser client applies different strategies based on the file type that changed:

### CSS — Hot Swap (No Page Reload)

When a `.css` file changes:

1. The client finds all `<link rel="stylesheet">` elements whose `href` matches the changed file.
2. It fetches the new CSS with a cache-busting query parameter (`?v=<timestamp>`).
3. It appends a new `<link>` element with the updated CSS.
4. After a short delay (50ms), the old `<link>` is removed.

**Result:** Styles update instantly. Page state (scroll position, form values, JS state) is fully preserved.

### HTML/TSX — Smart DOM Diffing

When an `.html` or `.tsx` file changes and it is the current page's file:

1. The client fetches the new version of the current URL (`fetch(location.href)`).
2. It computes a **bigram similarity score** between the old and new HTML strings.
3. **If the change is small (<15% difference):** A recursive DOM patching algorithm (`patchDOM`) surgically updates only the changed nodes, preserving form input values, checked states, and select values.
4. **If the change is large (≥15% difference):** A full page reload is triggered.

**Result:** Small template edits (text changes, class additions) update instantly without reloading. Large structural rewrites trigger a controlled reload.

### TypeScript/JavaScript — Full Reload

When a `.ts` or `.js` file that is not a backend file changes, the browser performs a full `location.reload()`.

### Backend Files — Worker Restart

When files that affect the server runtime change, the worker process exits with code `42`. The dev master process catches this and restarts the worker:

**Backend files that trigger restarts:**
- `server.config.ts`
- `schema.ts`
- `api/**/*`
- `**/.server/**/*`
- Any `*.tsx` file (since TSX files are executed server-side)

---

## Visibility-Aware Reloading

If a file changes while the browser tab is in the background (hidden), the reload is deferred until the tab becomes visible again. This prevents jarring reloads when you alt-tab back.

---

## Client Log Forwarding

The live reload client intercepts all `console.log`, `console.warn`, and `console.error` calls and forwards them to the server terminal via the WebSocket connection. This means browser-side errors appear in your terminal alongside server-side logs.

Forwarded log levels:
- `console.log` → `info`
- `console.warn` → `warn`
- `console.error` → `error`

Unhandled promise rejections and `window.onerror` events are also forwarded.

---

## Force Reload

You can trigger a force reload of all connected browsers programmatically (e.g., from an API endpoint):

```typescript
// api/force-reload.ts
import { Bakery } from '@server/core/bakery'

export default function() {
  Bakery.server?.publish('livereload', 'force_reload')
  return { ok: true }
}
```

The client also supports a force reload request from the browser itself:

```javascript
// From the browser console (via the `/_client/utils.js` client library)
Bakery.forceReload()
```

---

## Logger Terminal

In development, pressing `d` in the server terminal spawns a secondary terminal window that displays real-time server logs. This is useful when the main terminal is noisy with compile events.

The spawned terminal runs `.server/client/log.ts` as a subprocess, which connects to the main server process via the WebSocket logger subscription mechanism.

Supported terminals (Linux): `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xfce4-terminal`, `kitty`, `alacritty`, `xterm`.

---

## File Watcher Ignored Patterns

The following paths are ignored by the file watcher and will never trigger a reload:

```
node_modules/**/*
**/.git/**/*
**/.vscode/**/*
**/.backups/**/*
**/.cache/**/*
```

The watcher only reacts to files matching these extensions: `ts`, `tsx`, `js`, `jsx`, `css`, `html`.

---

## Disabling Live Reload

Live reload is automatically disabled in production mode (`bun run serve` without `--dev`). The `/_livereload` WebSocket endpoint returns early when `import.meta.env.WORKER` is `false`.

To force-disable live reload in development (e.g., for performance profiling), you can remove the `LiveReloadHandler` registration in `.server/core/startup.ts`. This is an advanced modification.

---

*[← WebSockets](../features/websockets.md) · [Dev Mode Architecture →](./dev-mode.md)*

*[← Back to README](../../README.md)*
